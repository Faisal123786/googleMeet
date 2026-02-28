require('dotenv').config();
const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const { Server } = require('socket.io');
const mediasoup  = require('mediasoup');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
app.get('/', (req, res) => res.send('Server OK'));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

let worker, router;
const peers = {};

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000, parameters: {} }
];

(async () => {
  try {
    worker = await mediasoup.createWorker({ logLevel: 'warn', rtcMinPort: 10000, rtcMaxPort: 10100 });
    worker.on('died', () => { console.error('Worker died'); process.exit(1); });
    router = await worker.createRouter({ mediaCodecs });
    console.log('✅ Mediasoup ready');
  } catch (e) {
    console.error('❌ Mediasoup failed:', e.message);
    process.exit(1);
  }
})();

async function makeTransport() {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.SERVER_IP || '127.0.0.1' }],
    enableUdp: true, enableTcp: true, preferUdp: true
  });
}

io.on('connection', socket => {
  console.log('🔌 Connected:', socket.id);
  peers[socket.id] = { sendTransport: null, recvTransport: null, producers: {}, consumers: {} };

  // ── 1. getRouterRtpCapabilities ──────────────────────────────────────────
  // FIX: server accepts (callback) only — no data argument
  socket.on('getRouterRtpCapabilities', (callback) => {
    console.log(`[${socket.id}] getRouterRtpCapabilities`);
    if (typeof callback !== 'function') {
      console.error('getRouterRtpCapabilities: callback is not a function, got:', typeof callback);
      return;
    }
    callback(router.rtpCapabilities);
  });

  // ── 2. createTransport ───────────────────────────────────────────────────
  socket.on('createTransport', async ({ direction }, callback) => {
    console.log(`[${socket.id}] createTransport direction=${direction}`);
    try {
      const t = await makeTransport();
      t.on('dtlsstatechange', s => { if (s === 'closed') t.close(); });
      peers[socket.id][direction === 'send' ? 'sendTransport' : 'recvTransport'] = t;
      callback({
        id: t.id,
        iceParameters:  t.iceParameters,
        iceCandidates:  t.iceCandidates,
        dtlsParameters: t.dtlsParameters
      });
    } catch (e) {
      console.error('createTransport error:', e.message);
      callback({ error: e.message });
    }
  });

  // ── 3. connectTransport ──────────────────────────────────────────────────
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    console.log(`[${socket.id}] connectTransport id=${transportId}`);
    const peer = peers[socket.id];
    const t = peer.sendTransport?.id === transportId ? peer.sendTransport
            : peer.recvTransport?.id === transportId ? peer.recvTransport : null;
    if (!t) return callback({ error: 'Transport not found' });
    try {
      await t.connect({ dtlsParameters });
      callback({ connected: true });
    } catch (e) {
      console.error('connectTransport error:', e.message);
      callback({ error: e.message });
    }
  });

  // ── 4. produce ───────────────────────────────────────────────────────────
  socket.on('produce', async ({ kind, rtpParameters, appData }, callback) => {
    console.log(`[${socket.id}] produce kind=${kind}`);
    const peer = peers[socket.id];
    if (!peer.sendTransport) return callback({ error: 'No send transport' });
    try {
      const producer = await peer.sendTransport.produce({ kind, rtpParameters, appData: appData || {} });
      producer.on('transportclose', () => producer.close());
      peer.producers[producer.id] = { producer, kind };
      socket.broadcast.emit('newProducer', { producerId: producer.id, producerSocketId: socket.id, kind });
      callback({ id: producer.id });
    } catch (e) {
      console.error('produce error:', e.message);
      callback({ error: e.message });
    }
  });

  // ── 5. consume ───────────────────────────────────────────────────────────
  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
    console.log(`[${socket.id}] consume producerId=${producerId}`);
    try {
      if (!router.canConsume({ producerId, rtpCapabilities }))
        return callback({ error: 'Cannot consume' });
      const peer = peers[socket.id];
      if (!peer.recvTransport) return callback({ error: 'No recv transport' });
      const consumer = await peer.recvTransport.consume({ producerId, rtpCapabilities, paused: false });
      peer.consumers[producerId] = consumer;
      consumer.on('producerclose', () => {
        consumer.close();
        socket.emit('consumerClosed', { consumerId: consumer.id, producerId });
      });
      callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (e) {
      console.error('consume error:', e.message);
      callback({ error: e.message });
    }
  });

  // ── 6. getProducers (late join) ──────────────────────────────────────────
  // FIX: returns plain array (not wrapped in object) to match client expectation
  socket.on('getProducers', (callback) => {
    if (typeof callback !== 'function') return;
    const list = [];
    for (const [sid, peer] of Object.entries(peers)) {
      if (sid === socket.id) continue;
      for (const [, { kind, producer }] of Object.entries(peer.producers)) {
        list.push({ producerId: producer.id, producerSocketId: sid, kind });
      }
    }
    console.log(`[${socket.id}] getProducers → ${list.length} producers`);
    callback(list);  // plain array
  });

  // ── 7. disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('🔴 Disconnected:', socket.id);
    const peer = peers[socket.id];
    if (!peer) return;
    Object.values(peer.consumers).forEach(c => c.close());
    Object.values(peer.producers).forEach(({ producer }) => producer.close());
    peer.sendTransport?.close();
    peer.recvTransport?.close();
    delete peers[socket.id];
    socket.broadcast.emit('peerLeft', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server: http://localhost:${PORT}`));