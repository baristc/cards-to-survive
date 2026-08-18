const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_URL || "*", methods: ["GET", "POST"] } });
const rooms = {};
const matchmakingQueues = new Map();
const suits = ["♥", "♠", "♣", "♦"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

function createRoomCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += characters[Math.floor(Math.random() * characters.length)];
  return rooms[code] ? createRoomCode() : code;
}

function shuffle(cards) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function createDeck() {
  return suits.flatMap((suit) => ranks.map((rank) => ({ id: `${suit}-${rank}`, suit, rank })));
}

function publicPlayers(room) {
  return room.players.map((player) => ({
    id: player.id,
    name: player.name,
    ready: player.ready,
    connected: player.connected !== false,
    cardCount: room.game?.decks[player.id]?.length ?? 0,
    eliminated: room.game ? (room.game.decks[player.id]?.length ?? 0) === 0 : false,
  }));
}

function sendGameState(room) {
  room.players.forEach((player) => {
    const game = room.game;
    io.to(player.id).emit("gameUpdated", {
      roomCode: room.roomCode,
      round: game.round,
      phase: game.phase,
      deadline: game.deadline,
      players: publicPlayers(room),
      options: game.phase === "selecting" ? game.options[player.id] ?? [] : [],
      hasSelected: Boolean(game.choices[player.id]),
      selectedPlayerIds: Object.keys(game.choices),
      trump: game.trump,
      roundCards: game.roundCards,
      roundWinnerId: game.roundWinnerId,
      winnerId: game.winnerId,
      rpsPlayerIds: game.rps?.playerIds ?? [],
      rpsSelectedPlayerIds: Object.keys(game.rps?.choices ?? {}),
      myRpsChoice: game.rps?.choices[player.id] ?? null,
      rpsAttempt: game.rps?.attempt ?? 0,
      finalMode: activePlayers(room).length === 2,
      stats: game.stats,
      elapsedSeconds: Math.floor((Date.now() - game.startedAt) / 1000),
      winTarget: room.winTarget,
      playUntilCardsEnd: room.playUntilCardsEnd,
      removedCardCount: game.removedCards?.length ?? 0,
    });
  });
}

function activePlayers(room) {
  return room.players.filter((player) => (room.game.decks[player.id]?.length ?? 0) > 0);
}

function startRound(room) {
  const game = room.game;
  const active = activePlayers(room);
  const targetWinner = !room.playUntilCardsEnd
    ? room.players.find((player) => game.stats[player.id].roundsWon >= room.winTarget)
    : null;
  if (targetWinner || active.length <= 1) {
    game.phase = "finished";
    game.winnerId = targetWinner?.id ?? active[0]?.id ?? null;
    game.deadline = null;
    sendGameState(room);
    return;
  }

  game.round += 1;
  game.phase = "selecting";
  game.choices = {};
  game.options = {};
  game.trump = null;
  game.roundCards = [];
  game.roundWinnerId = null;
  game.rps = null;
  game.deadline = Date.now() + 15000;
  active.forEach((player) => {
    game.options[player.id] = shuffle(game.decks[player.id]).slice(0, 4);
  });
  sendGameState(room);
  game.timer = setTimeout(() => {
    activePlayers(room).forEach((player) => {
      if (!game.choices[player.id]) {
        const options = game.options[player.id];
        game.choices[player.id] = options[Math.floor(Math.random() * options.length)];
      }
    });
    resolveRound(room);
  }, 15000);
}

function awardRound(room, winnerId, wonWithRps = false) {
  const game = room.game;
  const playedCards = Object.values(game.choices);
  game.decks[winnerId].push(...playedCards);
  game.stats[winnerId].roundsWon += 1;
  game.stats[winnerId].cardsWon += playedCards.length;
  if (game.choices[winnerId]?.suit === game.trump) game.stats[winnerId].trumpWins += 1;
  if (wonWithRps) game.stats[winnerId].rpsWins += 1;
  game.roundCards = room.players
    .filter((player) => game.choices[player.id])
    .map((player) => ({ playerId: player.id, playerName: player.name, card: game.choices[player.id] }));
  game.roundWinnerId = winnerId;
  game.phase = "revealing";
  game.deadline = null;
  sendGameState(room);
  game.timer = setTimeout(() => startRound(room), 3500);
}

function resolveRound(room) {
  const game = room.game;
  clearTimeout(game.timer);
  Object.entries(game.choices).forEach(([playerId, card]) => {
    const index = game.decks[playerId].findIndex((item) => item.id === card.id);
    if (index !== -1) game.decks[playerId].splice(index, 1);
  });
  game.trump = suits[Math.floor(Math.random() * suits.length)];
  const entries = Object.entries(game.choices);
  const trumpCards = entries.filter(([, card]) => card.suit === game.trump);
  const candidates = trumpCards.length ? trumpCards : entries;
  const highest = Math.max(...candidates.map(([, card]) => ranks.indexOf(card.rank)));
  const tiedIds = candidates.filter(([, card]) => ranks.indexOf(card.rank) === highest).map(([id]) => id);

  game.phase = "trumpSpinning";
  game.deadline = null;
  game.pendingTiedIds = tiedIds;
  game.roundCards = room.players
    .filter((player) => game.choices[player.id])
    .map((player) => ({ playerId: player.id, playerName: player.name, card: game.choices[player.id] }));
  sendGameState(room);
  game.timer = setTimeout(() => {
    if (game.pendingTiedIds.length === 1) return awardRound(room, game.pendingTiedIds[0]);
    game.phase = "rps";
    game.rps = { playerIds: game.pendingTiedIds, choices: {}, attempt: 1 };
    startRpsTimer(room);
    sendGameState(room);
  }, 3200);
}

function startRpsTimer(room) {
  clearTimeout(room.game.timer);
  room.game.deadline = Date.now() + 10000;
  room.game.timer = setTimeout(() => {
    const rps = room.game.rps;
    rps.playerIds.forEach((id) => {
      if (!rps.choices[id]) rps.choices[id] = ["rock", "paper", "scissors"][Math.floor(Math.random() * 3)];
    });
    resolveRps(room);
  }, 10000);
}

function resolveRps(room) {
  clearTimeout(room.game.timer);
  const rps = room.game.rps;
  if (!rps) return;
  const values = [...new Set(Object.values(rps.choices))];
  if (values.length !== 2) {
    rps.choices = {};
    rps.attempt += 1;
    startRpsTimer(room);
    sendGameState(room);
    return;
  }
  const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
  const winningChoice = beats[values[0]] === values[1] ? values[0] : values[1];
  const winners = rps.playerIds.filter((id) => rps.choices[id] === winningChoice);
  if (winners.length === 1) return awardRound(room, winners[0], true);
  rps.playerIds = winners;
  rps.choices = {};
  rps.attempt += 1;
  startRpsTimer(room);
  sendGameState(room);
}

function publicRoom(room) {
  return {
    roomCode: room.roomCode,
    maxPlayers: room.maxPlayers,
    winTarget: room.winTarget,
    playUntilCardsEnd: room.playUntilCardsEnd,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map(({ id, name, ready, connected }) => ({ id, name, ready, connected: connected !== false })),
  };
}

function moveGamePlayerId(game, oldId, newId) {
  if (!game) return;
  ["decks", "options", "choices", "stats"].forEach((key) => {
    if (game[key]?.[oldId] !== undefined) {
      game[key][newId] = game[key][oldId];
      delete game[key][oldId];
    }
  });
  if (game.rps) {
    game.rps.playerIds = game.rps.playerIds.map((id) => id === oldId ? newId : id);
    if (game.rps.choices[oldId] !== undefined) {
      game.rps.choices[newId] = game.rps.choices[oldId];
      delete game.rps.choices[oldId];
    }
  }
  game.pendingTiedIds = game.pendingTiedIds?.map((id) => id === oldId ? newId : id);
  game.roundCards = game.roundCards.map((item) => item.playerId === oldId ? { ...item, playerId: newId } : item);
  if (game.roundWinnerId === oldId) game.roundWinnerId = newId;
  if (game.winnerId === oldId) game.winnerId = newId;
}

function initializeGame(room) {
  if (!room || room.started) return;
  const deck = shuffle(createDeck());
  const cardsPerPlayer = Math.floor(deck.length / room.players.length);
  const playableCardCount = cardsPerPlayer * room.players.length;
  const playableCards = deck.slice(0, playableCardCount);
  const removedCards = deck.slice(playableCardCount);
  const decks = Object.fromEntries(room.players.map((player, playerIndex) => [player.id, playableCards.slice(playerIndex * cardsPerPlayer, (playerIndex + 1) * cardsPerPlayer)]));
  room.started = true;
  room.game = { decks, removedCards, round: 0, phase: "starting", choices: {}, options: {}, trump: null, roundCards: [], roundWinnerId: null, winnerId: null, deadline: null, rps: null, timer: null, startedAt: Date.now(), stats: Object.fromEntries(room.players.map((player) => [player.id, { roundsWon: 0, cardsWon: 0, trumpWins: 0, rpsWins: 0 }])) };
  io.to(room.roomCode).emit("gameStarted");
  startRound(room);
}
const MATCHMAKING_FALLBACK_MS = Number(process.env.MATCHMAKING_FALLBACK_MS) || 30000;
function queueKey(maxPlayers, winTarget, playUntilCardsEnd) { return `${maxPlayers}:${playUntilCardsEnd ? "cards" : winTarget}`; }
function isInMatchmaking(socketId) { return [...matchmakingQueues.values()].some((queue) => queue.some((entry) => entry.socketId === socketId)); }
function notifyQueue(queue) { queue.forEach((entry) => io.to(entry.socketId).emit("matchmakingUpdate", { current: queue.length, required: entry.maxPlayers, expanded: Date.now() - entry.joinedAt >= MATCHMAKING_FALLBACK_MS })); }
function removeFromMatchmaking(socketId, notify = true) {
  for (const [key, queue] of matchmakingQueues) {
    const index = queue.findIndex((entry) => entry.socketId === socketId);
    if (index === -1) continue;
    queue.splice(index, 1);
    if (!queue.length) matchmakingQueues.delete(key); else notifyQueue(queue);
    if (notify) io.to(socketId).emit("matchmakingCancelled");
    return true;
  }
  return false;
}
function createMatch(matched) {
  const required = matched[0].maxPlayers;
  const first = [...matched].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  const roomCode = createRoomCode();
  const room = { roomCode, maxPlayers: required, winTarget: first.winTarget, playUntilCardsEnd: first.playUntilCardsEnd, hostId: first.socketId, players: matched.map((entry) => ({ id: entry.socketId, token: entry.playerToken, name: entry.playerName, ready: true, connected: true, reconnectTimer: null })), started: false, matchmaking: true };
  rooms[roomCode] = room;
  matched.forEach((entry) => io.sockets.sockets.get(entry.socketId)?.join(roomCode));
  io.to(roomCode).emit("matchFound", publicRoom(room));
  setTimeout(() => initializeGame(rooms[roomCode]), 3000);
}
function tryCreateMatch(key) {
  const queue = (matchmakingQueues.get(key) || []).filter((entry) => io.sockets.sockets.has(entry.socketId));
  if (!queue.length) { matchmakingQueues.delete(key); return; }
  matchmakingQueues.set(key, queue);
  const required = queue[0].maxPlayers;
  if (queue.length < required) { notifyQueue(queue); return; }
  const matched = queue.splice(0, required);
  if (!queue.length) matchmakingQueues.delete(key); else { matchmakingQueues.set(key, queue); notifyQueue(queue); }
  createMatch(matched);
  if (queue.length >= required) tryCreateMatch(key);
}
function tryBroadMatch(maxPlayers) {
  const entries = [];
  for (const [key, queue] of matchmakingQueues) {
    const connected = queue.filter((entry) => io.sockets.sockets.has(entry.socketId));
    if (!connected.length) matchmakingQueues.delete(key); else matchmakingQueues.set(key, connected);
    entries.push(...connected.filter((entry) => entry.maxPlayers === maxPlayers));
  }
  entries.sort((a, b) => a.joinedAt - b.joinedAt);
  if (entries.length < maxPlayers || Date.now() - entries[0].joinedAt < MATCHMAKING_FALLBACK_MS) return;
  const matched = entries.slice(0, maxPlayers);
  const matchedIds = new Set(matched.map((entry) => entry.socketId));
  for (const [key, queue] of matchmakingQueues) {
    const remaining = queue.filter((entry) => !matchedIds.has(entry.socketId));
    if (!remaining.length) matchmakingQueues.delete(key); else { matchmakingQueues.set(key, remaining); notifyQueue(remaining); }
  }
  createMatch(matched);
  tryBroadMatch(maxPlayers);
}app.get("/", (req, res) => res.send("Cards to Survive server çalışıyor."));

io.on("connection", (socket) => {
  socket.on("joinMatchmaking", ({ playerName, playerCount, winTarget, playUntilCardsEnd, playerToken }) => {
    const cleanName = playerName?.trim(); const maxPlayers = Number(playerCount); const cleanTarget = Math.min(99, Math.max(1, Number(winTarget) || 10));
    if (!cleanName) return socket.emit("roomError", "Oyuncu adı boş bırakılamaz.");
    if (![2, 3, 4].includes(maxPlayers)) return socket.emit("roomError", "Oyuncu sayısı geçersiz.");
    removeFromMatchmaking(socket.id, false);
    const key = queueKey(maxPlayers, cleanTarget, Boolean(playUntilCardsEnd)); const queue = matchmakingQueues.get(key) || [];
    const entry = { socketId: socket.id, playerName: cleanName, playerToken, maxPlayers, winTarget: cleanTarget, playUntilCardsEnd: Boolean(playUntilCardsEnd), joinedAt: Date.now() };
    queue.push(entry); matchmakingQueues.set(key, queue);
    notifyQueue(queue);
    tryCreateMatch(key);
    if (isInMatchmaking(socket.id)) tryBroadMatch(maxPlayers);
    setTimeout(() => {
      if (!isInMatchmaking(socket.id)) return;
      socket.emit("matchmakingExpanded");
      tryBroadMatch(maxPlayers);
    }, MATCHMAKING_FALLBACK_MS);
  });
  socket.on("cancelMatchmaking", () => removeFromMatchmaking(socket.id));
  socket.on("createRoom", ({ playerName, playerCount, winTarget, playUntilCardsEnd, playerToken }) => {
    const cleanName = playerName?.trim();
    const maxPlayers = Number(playerCount);
    if (!cleanName) return socket.emit("roomError", "Oyuncu adı boş bırakılamaz.");
    if (![2, 3, 4].includes(maxPlayers)) return socket.emit("roomError", "Oyuncu sayısı geçersiz.");
    const roomCode = createRoomCode();
    rooms[roomCode] = {
      roomCode,
      maxPlayers,
      winTarget: Math.min(99, Math.max(1, Number(winTarget) || 10)),
      playUntilCardsEnd: Boolean(playUntilCardsEnd),
      hostId: socket.id,
      players: [{ id: socket.id, token: playerToken, name: cleanName, ready: false, connected: true, reconnectTimer: null }],
      started: false,
    };
    socket.join(roomCode);
    socket.emit("roomCreated", publicRoom(rooms[roomCode]));
  });

  socket.on("joinRoom", ({ playerName, roomCode, playerToken }) => {
    const cleanName = playerName?.trim();
    const cleanCode = roomCode?.trim().toUpperCase();
    const room = rooms[cleanCode];
    if (!cleanName) return socket.emit("roomError", "Oyuncu adı boş bırakılamaz.");
    if (!room) return socket.emit("roomError", "Oda bulunamadı.");
    if (room.started) return socket.emit("roomError", "Oyun zaten başladı.");
    if (room.players.length >= room.maxPlayers) return socket.emit("roomError", "Oda dolu.");
    if (room.players.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) return socket.emit("roomError", "Bu oyuncu adı odada zaten kullanılıyor.");
    room.players.push({ id: socket.id, token: playerToken, name: cleanName, ready: false, connected: true, reconnectTimer: null });
    socket.join(cleanCode);
    io.to(cleanCode).emit("roomUpdated", publicRoom(room));
    socket.emit("roomJoined", publicRoom(room));
  });

  socket.on("kickPlayer", ({ roomCode, playerId }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    if (!room) return socket.emit("roomError", "Oda bulunamadı.");
    if (room.hostId !== socket.id) return socket.emit("roomError", "Oyuncuları yalnızca oda sahibi atabilir.");
    if (room.started) return socket.emit("roomError", "Oyun başladıktan sonra oyuncu atılamaz.");
    if (playerId === socket.id) return socket.emit("roomError", "Oda sahibi kendisini atamaz.");
    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex === -1) return socket.emit("roomError", "Oyuncu odada bulunamadı.");

    const [kickedPlayer] = room.players.splice(playerIndex, 1);
    clearTimeout(kickedPlayer.reconnectTimer);
    const targetSocket = io.sockets.sockets.get(playerId);
    targetSocket?.emit("kickedFromRoom", "Oda sahibi tarafından odadan çıkarıldın.");
    io.to(room.roomCode).emit("roomUpdated", publicRoom(room));
    setTimeout(() => targetSocket?.disconnect(true), 150);
  });

  socket.on("toggleReady", ({ roomCode }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    const player = room?.players.find((item) => item.id === socket.id);
    if (!player || room.started) return socket.emit("roomError", "Hazır durumu değiştirilemedi.");
    player.ready = !player.ready;
    io.to(room.roomCode).emit("roomUpdated", publicRoom(room));
  });

  socket.on("startGame", ({ roomCode }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    if (!room) return socket.emit("roomError", "Oda bulunamadı.");
    if (room.hostId !== socket.id) return socket.emit("roomError", "Oyunu yalnızca oda sahibi başlatabilir.");
    if (room.players.length !== room.maxPlayers) return socket.emit("roomError", "Oyunu başlatmak için oda dolu olmalı.");
    if (!room.players.every((p) => p.ready)) return socket.emit("roomError", "Tüm oyuncular hazır olmalı.");
    initializeGame(room);
  });

  socket.on("selectCard", ({ roomCode, cardId }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    if (!room?.started || room.game.phase !== "selecting") return socket.emit("roomError", "Şu anda kart seçilemez.");
    if (room.game.choices[socket.id]) return socket.emit("roomError", "Bu tur kartını zaten seçtin.");
    const card = room.game.options[socket.id]?.find((item) => item.id === cardId);
    if (!card) return socket.emit("roomError", "Bu kart seçeneklerinde yok.");
    room.game.choices[socket.id] = card;
    sendGameState(room);
    if (activePlayers(room).every((player) => room.game.choices[player.id])) resolveRound(room);
  });

  socket.on("rpsChoice", ({ roomCode, choice }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    if (!room?.started || room.game.phase !== "rps") return;
    if (!room.game.rps.playerIds.includes(socket.id)) return;
    if (!["rock", "paper", "scissors"].includes(choice)) return;
    if (room.game.rps.choices[socket.id]) return;
    room.game.rps.choices[socket.id] = choice;
    sendGameState(room);
    if (room.game.rps.playerIds.every((id) => room.game.rps.choices[id])) resolveRps(room);
  });

  socket.on("rematch", ({ roomCode }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    if (!room || room.hostId !== socket.id) return socket.emit("roomError", "Yeni maçı yalnızca oda sahibi başlatabilir.");
    if (room.game?.phase !== "finished") return socket.emit("roomError", "Maç henüz bitmedi.");
    clearTimeout(room.game.timer);
    room.started = false;
    room.game = null;
    room.players.forEach((player) => { player.ready = false; });
    io.to(room.roomCode).emit("backToLobby", publicRoom(room));
  });

  socket.on("reconnectRoom", ({ roomCode, playerToken }) => {
    const room = rooms[roomCode?.trim().toUpperCase()];
    const player = room?.players.find((item) => item.token === playerToken);
    if (!room || !player) return socket.emit("reconnectFailed");
    const oldId = player.id;
    clearTimeout(player.reconnectTimer);
    player.id = socket.id;
    player.connected = true;
    player.reconnectTimer = null;
    if (room.hostId === oldId) room.hostId = socket.id;
    moveGamePlayerId(room.game, oldId, socket.id);
    socket.join(room.roomCode);
    socket.emit("roomRejoined", publicRoom(room));
    if (room.started) sendGameState(room);
    else io.to(room.roomCode).emit("roomUpdated", publicRoom(room));
  });

  socket.on("leaveRoom", () => {
    socket.data.leaveNow = true;
    socket.disconnect(true);
  });

  socket.on("disconnect", () => {
    removeFromMatchmaking(socket.id, false);
    Object.entries(rooms).forEach(([code, room]) => {
      const player = room.players.find((item) => item.id === socket.id);
      if (!player) return;
      player.connected = false;

      const removePlayer = () => {
        const index = room.players.findIndex((item) => item.token === player.token);
        if (index === -1 || room.players[index].connected) return;
        room.players.splice(index, 1);
        if (!room.players.length) { clearTimeout(room.game?.timer); delete rooms[code]; return; }
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        if (room.started) {
          delete room.game.decks[socket.id];
          if (activePlayers(room).length <= 1) {
            clearTimeout(room.game.timer);
            room.game.phase = "finished";
            room.game.winnerId = activePlayers(room)[0]?.id ?? null;
            room.game.deadline = null;
          }
          sendGameState(room);
        } else io.to(code).emit("roomUpdated", publicRoom(room));
      };

      if (socket.data.leaveNow) removePlayer();
      else {
        player.reconnectTimer = setTimeout(removePlayer, 45000);
        if (room.started) sendGameState(room);
        else io.to(code).emit("roomUpdated", publicRoom(room));
      }
    });
  });});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => console.log(`Server ${PORT} portunda çalışıyor`));
