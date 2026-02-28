import React, { useRef, useState, useEffect, useCallback } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SERVER_URL = 'https://d869-39-63-56-65.ngrok-free.app';
const socket = io(SERVER_URL, { transports: ['websocket'] });

function emitAsync(event, data) {
  return new Promise((resolve, reject) => {
    const cb = (res) => {
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    };
    data === null || data === undefined
      ? socket.emit(event, cb)
      : socket.emit(event, data, cb);
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root    : { minHeight:'100vh', background:'#0d1117', color:'#cdd9e5', fontFamily:'monospace', padding:24 },
  title   : { color:'#58a6ff', fontSize:'1.4rem', fontWeight:700, marginBottom:4 },
  status  : { fontSize:12, color:'#8b949e', marginBottom:16 },
  error   : { color:'#f85149', fontSize:13, padding:'8px 12px', background:'#1f0d0d', borderRadius:6, marginTop:8 },
  btnJoin : { padding:'9px 24px', background:'#238636', color:'#fff', border:'none', borderRadius:6, fontWeight:700, cursor:'pointer', fontFamily:'monospace', fontSize:14 },
  btnLeave: { padding:'9px 24px', background:'#da3633', color:'#fff', border:'none', borderRadius:6, fontWeight:700, cursor:'pointer', fontFamily:'monospace', fontSize:14 },
  grid    : { display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:16, marginTop:20 },
  card    : { background:'#161b22', border:'1px solid #30363d', borderRadius:10, overflow:'hidden', position:'relative' },
  video   : { width:'100%', maxHeight:200, objectFit:'cover', background:'#000', display:'block' },
  badge   : { position:'absolute', bottom:8, left:8, background:'rgba(0,0,0,.75)', color:'#cdd9e5', fontSize:11, padding:'3px 8px', borderRadius:4 },
  audioIcon: { position:'absolute', bottom:8, right:8, background:'rgba(0,0,0,.75)', color:'#3fb950', fontSize:11, padding:'3px 8px', borderRadius:4 },
};

// ─── PeerCard — ek peer ka video + audio ek saath ─────────────────────────────
// FIX: audio aur video alag cards nahi — ek card mein dono
function PeerCard({ socketId, videoStream, audioStream }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && videoStream) videoRef.current.srcObject = videoStream;
  }, [videoStream]);

  useEffect(() => {
    if (audioRef.current && audioStream) {
      audioRef.current.srcObject = audioStream;
      // FIX: audio muted NAHI hona chahiye — yahi awaaz band kar raha tha
      audioRef.current.muted = false;
      audioRef.current.volume = 1.0;
      audioRef.current.play().catch(e => console.warn('audio play error:', e));
    }
  }, [audioStream]);

  return (
    <div style={S.card}>
      {/* Video element */}
      <video ref={videoRef} autoPlay playsInline muted={false} style={S.video} />

      {/* Hidden audio element — sirf awaaz ke liye */}
      <audio ref={audioRef} autoPlay playsInline muted={false} style={{ display:'none' }} />

      <span style={S.badge}>{socketId.slice(0, 6)}…</span>
      {audioStream && <span style={S.audioIcon}>🔊</span>}
    </div>
  );
}

// ─── Local video card ─────────────────────────────────────────────────────────
function LocalCard({ videoRef }) {
  return (
    <div style={S.card}>
      <video ref={videoRef} autoPlay playsInline muted style={S.video} />
      <span style={S.badge}>You</span>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const localVideoRef = useRef(null);
  const deviceRef     = useRef(null);
  const sendTransRef  = useRef(null);
  const recvTransRef  = useRef(null);

  const [joined,     setJoined]     = useState(false);
  const [status,     setStatus]     = useState('Not connected');
  const [socketOk,   setSocketOk]   = useState(false);
  const [error,      setError]      = useState('');

  // FIX: remoteStreams structure changed
  // { socketId: { videoStream: MediaStream|null, audioStream: MediaStream|null } }
  const [remotePeers, setRemotePeers] = useState({});

  // ── Socket status ─────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('connect',       () => { setSocketOk(true);  setStatus('Socket connected ✓'); setError(''); });
    socket.on('disconnect',    () => { setSocketOk(false); setStatus('Socket disconnected'); });
    socket.on('connect_error', (e) => { setSocketOk(false); setError(`Server nahi mila: ${e.message}`); });
    return () => { socket.off('connect'); socket.off('disconnect'); socket.off('connect_error'); };
  }, []);

  // ── Helper: remotePeers mein track add karo ───────────────────────────────
  // FIX: video aur audio ALAG keys mein nahi, ek peer object mein
  const addRemoteTrack = useCallback((socketId, kind, track) => {
    const stream = new MediaStream([track]);
    setRemotePeers(prev => ({
      ...prev,
      [socketId]: {
        ...prev[socketId],
        [kind === 'video' ? 'videoStream' : 'audioStream']: stream
      }
    }));
  }, []);

  // ── consumeProducer ───────────────────────────────────────────────────────
  const consumeProducer = useCallback(async ({ producerId, producerSocketId, kind }) => {
    const device = deviceRef.current;
    const recv   = recvTransRef.current;
    if (!device || !recv) return;

    try {
      const res = await emitAsync('consume', { producerId, rtpCapabilities: device.rtpCapabilities });
      const consumer = await recv.consume({
        id: res.id, producerId: res.producerId, kind: res.kind, rtpParameters: res.rtpParameters
      });

      // FIX: har track ko uske peer ke card mein daalo — alag card nahi
      addRemoteTrack(producerSocketId, consumer.kind, consumer.track);

      consumer.on('transportclose', () => {
        setRemotePeers(prev => {
          const n = { ...prev };
          if (n[producerSocketId]) {
            if (consumer.kind === 'video') delete n[producerSocketId].videoStream;
            else                           delete n[producerSocketId].audioStream;
            if (!n[producerSocketId].videoStream && !n[producerSocketId].audioStream)
              delete n[producerSocketId];
          }
          return n;
        });
      });
    } catch (e) {
      console.error('consumeProducer error:', e.message);
    }
  }, [addRemoteTrack]);

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('newProducer', async (info) => {
      if (deviceRef.current && recvTransRef.current) await consumeProducer(info);
    });
    socket.on('peerLeft', ({ socketId }) => {
      setRemotePeers(prev => { const n = {...prev}; delete n[socketId]; return n; });
    });
    return () => { socket.off('newProducer'); socket.off('peerLeft'); };
  }, [consumeProducer]);

  // ── buildTransport ────────────────────────────────────────────────────────
  async function buildTransport(direction) {
    const opts = await emitAsync('createTransport', { direction });
    const device = deviceRef.current;
    const transport = direction === 'send'
      ? device.createSendTransport(opts)
      : device.createRecvTransport(opts);

    transport.on('connect', ({ dtlsParameters }, callback, errback) =>
      emitAsync('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback()).catch(errback)
    );
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) =>
        emitAsync('produce', { kind, rtpParameters, appData })
          .then(res => callback({ id: res.id })).catch(errback)
      );
      sendTransRef.current = transport;
    } else {
      recvTransRef.current = transport;
    }
    return transport;
  }

  // ── joinCall ──────────────────────────────────────────────────────────────
  const joinCall = async () => {
    setError('');
    try {
      setStatus('Camera/mic access…');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      setStatus('Loading mediasoup device…');
      const routerRtpCapabilities = await emitAsync('getRouterRtpCapabilities', null);
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      deviceRef.current = device;

      setStatus('Creating transports…');
      await buildTransport('send');
      await buildTransport('recv');

      setStatus('Publishing tracks…');
      if (device.canProduce('video')) await sendTransRef.current.produce({ track: stream.getVideoTracks()[0] });
      if (device.canProduce('audio')) await sendTransRef.current.produce({ track: stream.getAudioTracks()[0] });

      setStatus('Getting existing peers…');
      const existing = await emitAsync('getProducers', null);
      if (Array.isArray(existing)) {
        for (const info of existing) await consumeProducer(info);
      }

      setJoined(true);
      setStatus(`In call ✓  (${socket.id})`);
    } catch (e) {
      console.error('joinCall failed:', e);
      setError(`Join failed: ${e.message}`);
      setStatus('Error');
    }
  };

  // ── leaveCall ─────────────────────────────────────────────────────────────
  const leaveCall = () => {
    if (localVideoRef.current?.srcObject) {
      localVideoRef.current.srcObject.getTracks().forEach(t => t.stop());
      localVideoRef.current.srcObject = null;
    }
    sendTransRef.current?.close(); sendTransRef.current = null;
    recvTransRef.current?.close(); recvTransRef.current = null;
    deviceRef.current = null;
    setRemotePeers({});
    setJoined(false);
    setStatus('Left call');
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <div style={S.title}>◈ SFU Group Call</div>
      <div style={S.status}>
        <span style={{ color: socketOk ? '#3fb950' : '#f85149' }}>{socketOk ? '● ' : '○ '}</span>
        {status}
      </div>

      {error && <div style={S.error}>⚠ {error}</div>}

      <div style={{ marginTop: 16 }}>
        {!joined
          ? <button style={S.btnJoin}  onClick={joinCall}  disabled={!socketOk}>
              {socketOk ? 'Join Call' : 'Connecting…'}
            </button>
          : <button style={S.btnLeave} onClick={leaveCall}>Leave Call</button>
        }
      </div>

      <div style={S.grid}>
        {/* Local — muted taake apni awaaz echo na ho */}
        <LocalCard videoRef={localVideoRef} />

        {/* FIX: Har remote peer ka SIRF EK card — video + audio dono ek mein */}
        {Object.entries(remotePeers).map(([socketId, { videoStream, audioStream }]) => (
          <PeerCard
            key={socketId}
            socketId={socketId}
            videoStream={videoStream || null}
            audioStream={audioStream || null}
          />
        ))}
      </div>
    </div>
  );
}
