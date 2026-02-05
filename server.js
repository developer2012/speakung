// server.js
// Simple real-time matchmaking + chat (WebSocket)
// Run: node server.js
// Env: PORT (optional)

const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("sayra matchmaking server is running.\n");
});

const wss = new WebSocket.Server({ server });

// Waiting queue: [{ ws, prefs, enqueuedAt }]
const queue = [];
// Active rooms: roomId -> { a, b }
const rooms = new Map();
// Map ws -> { id, roomId, state, prefs }
const clients = new Map();

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function removeFromQueue(ws) {
  const idx = queue.findIndex((q) => q.ws === ws);
  if (idx !== -1) queue.splice(idx, 1);
}

function leaveRoom(ws) {
  const meta = clients.get(ws);
  if (!meta || !meta.roomId) return;

  const roomId = meta.roomId;
  const room = rooms.get(roomId);
  if (!room) {
    meta.roomId = null;
    meta.state = "idle";
    return;
  }

  const other = room.a === ws ? room.b : room.a;

  // notify other
  if (other && other.readyState === WebSocket.OPEN) {
    const otherMeta = clients.get(other);
    if (otherMeta) {
      otherMeta.roomId = null;
      otherMeta.state = "idle";
    }
    safeSend(other, { type: "partner_left" });
  }

  rooms.delete(roomId);

  meta.roomId = null;
  meta.state = "idle";
}

function matchScore(p1, p2) {
  // prefs: { gender: "male|female|any", level: "beginner|intermediate|advanced|any" }
  // Return -Infinity if incompatible, else score
  const g1 = p1.gender || "any";
  const g2 = p2.gender || "any";
  const l1 = p1.level || "any";
  const l2 = p2.level || "any";

  // Gender matching (both sides choose a preference but we don't know partner gender in this demo)
  // In real app you'd store user profile gender. Here we treat gender pref as "desired partner gender".
  // So compatibility is always true; we only score if same preference (for UI realism).
  let score = 0;

  if (g1 === g2) score += 2;
  if (l1 === l2) score += 4;

  // if one is any and other specific, still ok
  if (l1 === "any" || l2 === "any") score += 1;
  if (g1 === "any" || g2 === "any") score += 1;

  // waiting time bonus (handled outside)
  return score;
}

function tryMatch() {
  if (queue.length < 2) return;

  // Pick the best pair based on score + waiting time
  let best = null;

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const A = queue[i];
      const B = queue[j];

      if (A.ws.readyState !== WebSocket.OPEN || B.ws.readyState !== WebSocket.OPEN) continue;

      const base = matchScore(A.prefs, B.prefs);
      if (!isFinite(base)) continue;

      const waitA = (Date.now() - A.enqueuedAt) / 1000;
      const waitB = (Date.now() - B.enqueuedAt) / 1000;
      const waitingBonus = Math.min(10, (waitA + waitB) / 6); // gentle bonus

      const total = base + waitingBonus;

      if (!best || total > best.total) {
        best = { i, j, total };
      }
    }
  }

  if (!best) return;

  const A = queue[best.i];
  const B = queue[best.j];

  // remove from queue (remove larger index first)
  queue.splice(best.j, 1);
  queue.splice(best.i, 1);

  const roomId = uid();
  rooms.set(roomId, { a: A.ws, b: B.ws });

  const metaA = clients.get(A.ws);
  const metaB = clients.get(B.ws);

  if (metaA) {
    metaA.roomId = roomId;
    metaA.state = "chat";
  }
  if (metaB) {
    metaB.roomId = roomId;
    metaB.state = "chat";
  }

  // Send matched event with a simple partner label
  safeSend(A.ws, {
    type: "matched",
    roomId,
    partner: { name: "Partner", badge: "Online" },
  });
  safeSend(B.ws, {
    type: "matched",
    roomId,
    partner: { name: "Partner", badge: "Online" },
  });
}

setInterval(() => {
  // clean dead sockets in queue
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
  }
  tryMatch();
}, 500);

wss.on("connection", (ws) => {
  const id = uid();
  clients.set(ws, { id, roomId: null, state: "idle", prefs: { gender: "any", level: "any" } });

  safeSend(ws, { type: "hello", id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    const meta = clients.get(ws);
    if (!meta) return;

    if (msg.type === "find") {
      // leave any room, remove from queue, then enqueue
      leaveRoom(ws);
      removeFromQueue(ws);

      meta.prefs = {
        gender: msg.prefs?.gender || "any",
        level: msg.prefs?.level || "any",
      };
      meta.state = "searching";

      queue.push({ ws, prefs: meta.prefs, enqueuedAt: Date.now() });
      safeSend(ws, { type: "searching" });
      tryMatch();
      return;
    }

    if (msg.type === "cancel") {
      removeFromQueue(ws);
      meta.state = "idle";
      safeSend(ws, { type: "canceled" });
      return;
    }

    if (msg.type === "chat") {
      // forward to partner in same room
      if (!meta.roomId) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const other = room.a === ws ? room.b : room.a;
      if (!other || other.readyState !== WebSocket.OPEN) {
        safeSend(ws, { type: "partner_left" });
        leaveRoom(ws);
        return;
      }

      safeSend(other, { type: "chat", text: String(msg.text || "") });
      return;
    }

    if (msg.type === "leave") {
      leaveRoom(ws);
      removeFromQueue(ws);
      meta.state = "idle";
      safeSend(ws, { type: "left" });
      return;
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    leaveRoom(ws);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
