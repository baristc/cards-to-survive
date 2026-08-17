import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(import.meta.env.VITE_SERVER_URL || "http://localhost:3001");
const playerToken = localStorage.getItem("cts-player-token") || crypto.randomUUID();
localStorage.setItem("cts-player-token", playerToken);

function App() {
  const [playerName, setPlayerName] = useState("");
  const [playerCount, setPlayerCount] = useState(2);
  const [roomCode, setRoomCode] = useState("");
  const [winTarget, setWinTarget] = useState(10);
  const [playUntilCardsEnd, setPlayUntilCardsEnd] = useState(false);
  const [createdRoom, setCreatedRoom] = useState(null);
  const [error, setError] = useState("");
  const [gameStarted, setGameStarted] = useState(false);
  const [gameState, setGameState] = useState(null);
  const [timeLeft, setTimeLeft] = useState(15);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [displayedTrump, setDisplayedTrump] = useState("♥");
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const handleConnect = () => {
      setIsConnected(true);
      const savedRoomCode = localStorage.getItem("cts-room-code");
      if (savedRoomCode) socket.emit("reconnectRoom", { roomCode: savedRoomCode, playerToken });
    };
    const handleDisconnect = () => setIsConnected(false);
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);

    socket.on("roomCreated", (room) => {
      localStorage.setItem("cts-room-code", room.roomCode);
      setCreatedRoom(room);
      setError("");
    });

    socket.on("roomJoined", (room) => {
      localStorage.setItem("cts-room-code", room.roomCode);
      setCreatedRoom(room);
      setError("");
    });

    socket.on("roomRejoined", (room) => {
      setCreatedRoom(room);
      setGameStarted(room.started);
      setError("");
    });

    socket.on("reconnectFailed", () => {
      localStorage.removeItem("cts-room-code");
    });

    socket.on("roomUpdated", (room) => {
      setCreatedRoom(room);
    });

    socket.on("gameStarted", () => {
      setGameStarted(true);
      setError("");
    });

    socket.on("gameUpdated", (state) => {
      setGameState(state);
      setGameStarted(true);
      setError("");
    });

    socket.on("backToLobby", (room) => {
      setCreatedRoom(room);
      setGameState(null);
      setGameStarted(false);
      setError("");
    });

    socket.on("kickedFromRoom", (message) => {
      localStorage.removeItem("cts-room-code");
      setCreatedRoom(null);
      setGameState(null);
      setGameStarted(false);
      setError(message);
      setTimeout(() => socket.connect(), 250);
    });

    socket.on("roomError", (message) => {
      setError(message);
    });

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("roomCreated");
      socket.off("roomJoined");
      socket.off("roomRejoined");
      socket.off("reconnectFailed");
      socket.off("roomUpdated");
      socket.off("gameStarted");
      socket.off("gameUpdated");
      socket.off("backToLobby");
      socket.off("kickedFromRoom");
      socket.off("roomError");
    };
  }, []);

  useEffect(() => {
    if (!gameState?.deadline) return;
    const updateTimer = () => setTimeLeft(Math.max(0, Math.ceil((gameState.deadline - Date.now()) / 1000)));
    updateTimer();
    const timer = setInterval(updateTimer, 250);
    return () => clearInterval(timer);
  }, [gameState?.deadline]);

  useEffect(() => {
    setSelectedCardId(null);
  }, [gameState?.round]);

  useEffect(() => {
    if (gameState?.phase !== "trumpSpinning") {
      if (gameState?.trump) setDisplayedTrump(gameState.trump);
      return;
    }
    const symbols = ["♥", "♠", "♣", "♦"];
    let index = 0;
    let delay = 70;
    let spinner;
    const spin = () => {
      setDisplayedTrump(symbols[index % symbols.length]);
      index += 1;
      delay = Math.min(420, delay * 1.14);
      spinner = setTimeout(spin, delay);
    };
    spin();
    return () => clearTimeout(spinner);
  }, [gameState?.phase, gameState?.trump]);

  useEffect(() => {
    if (!gameState?.phase || !soundEnabled) return;
    const tones = { selecting: 520, trumpSpinning: 690, revealing: 880, rps: 610, finished: 1040 };
    if (tones[gameState.phase]) playSound(tones[gameState.phase], gameState.phase === "finished" ? 0.5 : 0.18);
  }, [gameState?.phase, gameState?.round, soundEnabled]);

  const handleCreateRoom = () => {
    if (!socket.connected) {
      setError("Oyun sunucusuna bağlantı yok. Server'ı kontrol et.");
      return;
    }

    if (!playerName.trim()) {
      setError("Önce oyuncu adını gir.");
      return;
    }

    socket.emit("createRoom", {
      playerName,
      playerCount,
      winTarget,
      playUntilCardsEnd,
      playerToken,
    });
  };

  const handleJoinRoom = () => {
    if (!socket.connected) {
      setError("Oyun sunucusuna bağlantı yok. Server'ı kontrol et.");
      return;
    }

    if (!playerName.trim()) {
      setError("Önce oyuncu adını gir.");
      return;
    }

    if (roomCode.trim().length !== 6) {
      setError("6 karakterli oda kodunu gir.");
      return;
    }

    socket.emit("joinRoom", { playerName, roomCode, playerToken });
  };

  const handleKickPlayer = (playerId) => {
    socket.emit("kickPlayer", { roomCode: createdRoom.roomCode, playerId });
  };

  const handleToggleReady = () => {
    socket.emit("toggleReady", { roomCode: createdRoom.roomCode });
  };

  const handleStartGame = () => {
    socket.emit("startGame", { roomCode: createdRoom.roomCode });
  };

  const handleSelectCard = (cardId) => {
    setSelectedCardId(cardId);
    playSound(440);
    socket.emit("selectCard", { roomCode: createdRoom.roomCode, cardId });
  };

  const playSound = (frequency, duration = 0.12) => {
    if (!soundEnabled) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    [frequency, frequency * 1.25, frequency * 1.5].forEach((tone, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index === 0 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(tone, context.currentTime + index * 0.045);
      oscillator.frequency.exponentialRampToValueAtTime(tone * 0.82, context.currentTime + duration);
      gain.gain.setValueAtTime(index === 0 ? 0.055 : 0.025, context.currentTime + index * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration + index * 0.045);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + index * 0.045);
      oscillator.stop(context.currentTime + duration + index * 0.045);
    });
    setTimeout(() => context.close(), (duration + 0.3) * 1000);
  };

  const handleLeaveRoom = () => {
    localStorage.removeItem("cts-room-code");
    socket.emit("leaveRoom");
    setCreatedRoom(null);
    setGameState(null);
    setGameStarted(false);
    setError("");
    setTimeout(() => socket.connect(), 150);
  };

  const handleRematch = () => {
    socket.emit("rematch", { roomCode: createdRoom.roomCode });
  };

  const handleRpsChoice = (choice) => {
    socket.emit("rpsChoice", { roomCode: createdRoom.roomCode, choice });
  };

  if (createdRoom) {
    const currentPlayer = createdRoom.players.find(
      (player) => player.id === socket.id
    );
    const isHost = createdRoom.hostId === socket.id;
    const canStart =
      createdRoom.players.length === createdRoom.maxPlayers &&
      createdRoom.players.every((player) => player.ready);

    if (gameStarted && gameState) {
      const winner = gameState.players.find((player) => player.id === gameState.winnerId);
      const roundWinner = gameState.players.find((player) => player.id === gameState.roundWinnerId);
      const isRpsPlayer = gameState.rpsPlayerIds.includes(socket.id);
      const isHost = createdRoom.hostId === socket.id;
      const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

      return (
        <div className="app game-app">
          <div className="game-board">
            <div className="game-toolbar">
              <span className={isConnected ? "connection-online" : "connection-offline"}>{isConnected ? "● Bağlı" : "● Bağlantı kesildi"}</span>
              <div><button onClick={() => setSoundEnabled((value) => !value)}>{soundEnabled ? "🔊" : "🔇"}</button><button onClick={handleLeaveRoom}>🚪 Çık</button></div>
            </div>
            <header className="game-header">
              <div><small>ODA</small><strong>{gameState.roomCode}</strong></div>
              <div><small>TUR</small><strong>{gameState.round}</strong>{gameState.removedCardCount > 0 && <small>{gameState.removedCardCount} kart dışarıda</small>}</div>
              <div><small>SÜRE</small><strong>{gameState.phase === "selecting" ? timeLeft : "-"}</strong></div>
            </header>

            {gameState.finalMode && gameState.phase !== "finished" && <div className="final-mode-banner">⚔️ FİNAL — SON İKİ OYUNCU</div>}
            <div className="player-strip">
              {gameState.players.map((player) => (
                <div className={`game-player ${player.eliminated ? "eliminated" : ""}`} key={player.id}>
                  <span>{player.name} {player.connected === false && <small className="reconnecting-label">Bağlantı koptu — 45 sn bekleniyor</small>}</span><strong>🂠 × {player.cardCount}</strong>
                  {player.cardCount > 0 && player.cardCount <= 3 && <em>⚠️ {player.cardCount} kart kaldı</em>}
                  {player.eliminated && <em className="eliminated-label">ELENDİ</em>}
                  {gameState.selectedPlayerIds.includes(player.id) && <small>✓ Seçti</small>}
                </div>
              ))}
            </div>

            {gameState.phase === "selecting" && (
              <section className="selection-area">
                <h2>{gameState.hasSelected ? "Kartın seçildi — diğer oyuncular bekleniyor" : "Ortaya atacağın kartı seç"}</h2>
                <div className="selection-timer"><span style={{ width: `${(timeLeft / 15) * 100}%` }} /></div>
                <div className="hand-cards four-options">
                  {gameState.options.map((card) => (
                    <button key={card.id} disabled={gameState.hasSelected} onClick={() => handleSelectCard(card.id)} className={`playing-card hand-card deal-card ${selectedCardId === card.id ? "chosen-card" : gameState.hasSelected ? "returning-card" : ""} ${["♥", "♦"].includes(card.suit) ? "red-card" : ""}`}>
                      <span>{card.rank}</span><b>{card.suit}</b>
                    </button>
                  ))}
                </div>
                <p>Seçmediğin üç kart destene geri döner.</p>
              </section>
            )}

            {(["trumpSpinning", "revealing", "rps"].includes(gameState.phase)) && (
              <section className="round-result">
                <div className={`trump-wheel ${gameState.phase === "trumpSpinning" ? "is-spinning" : ""}`}>
                  <span>KOZ</span>
                  <div>{["♥", "♠", "♣", "♦"].map((suit) => <b key={suit} className={displayedTrump === suit ? "active" : ""}>{suit}</b>)}</div>
                </div>
                <div className="played-cards">
                  {gameState.roundCards.map((item) => (
                    <div key={item.playerId}><small>{item.playerName}</small><div className={`playing-card reveal-card ${gameState.phase === "revealing" ? `collecting-card ${item.playerId === gameState.roundWinnerId ? "winning-round-card" : "losing-round-card"}` : ""} ${["♥", "♦"].includes(item.card.suit) ? "red-card" : ""}`}><span>{item.card.rank}</span><b>{item.card.suit}</b></div></div>
                  ))}
                </div>
                {gameState.phase === "revealing" && <h2>{roundWinner?.name} turu kazandı ve kartları aldı!</h2>}
              </section>
            )}

            {gameState.phase === "rps" && (
              <section className="rps-panel">
                <h2>⚔️ BERABERLİK — TAŞ KAĞIT MAKAS</h2>
                <div className="rps-timer">Seçim için <strong>{timeLeft}</strong> saniye</div>
                <div className="rps-contenders">
                  {gameState.rpsPlayerIds.map((id) => {
                    const player = gameState.players.find((item) => item.id === id);
                    return <span className={gameState.rpsSelectedPlayerIds.includes(id) ? "picked" : ""} key={id}>{player?.name} {gameState.rpsSelectedPlayerIds.includes(id) ? "✓" : "…"}</span>;
                  })}
                </div>
                {isRpsPlayer ? (
                  <>
                    <div className="rps-buttons">
                      {[
                        { value: "rock", icon: "✊", label: "TAŞ" },
                        { value: "paper", icon: "✋", label: "KAĞIT" },
                        { value: "scissors", icon: "✌", label: "MAKAS" },
                      ].map((option) => (
                        <button
                          key={option.value}
                          className={gameState.myRpsChoice === option.value ? "selected-rps" : ""}
                          disabled={Boolean(gameState.myRpsChoice)}
                          onClick={() => handleRpsChoice(option.value)}
                        >
                          <span aria-hidden="true">{option.icon}</span>
                          <strong>{option.label}</strong>
                        </button>
                      ))}
                    </div>
                    {gameState.myRpsChoice && <p className="rps-confirmation">✓ Seçimin alındı. Rakibin bekleniyor.</p>}
                  </>
                ) : (
                  <p className="rps-spectator">Berabere kalan oyuncular seçim yapıyor.</p>
                )}
              </section>
            )}

            {gameState.phase === "finished" && (
              <section className="match-result">
                <div className="winner-banner">🏆 {winner?.name} OYUNU KAZANDI!</div>
                <p>Oyun süresi: {formatTime(gameState.elapsedSeconds)}</p>
                <div className="stats-grid">
                  {gameState.players.map((player) => (
                    <div key={player.id}><strong>{player.name}</strong><span>Tur: {gameState.stats[player.id]?.roundsWon ?? 0}</span><span>Toplanan kart: {gameState.stats[player.id]?.cardsWon ?? 0}</span><span>Koz galibiyeti: {gameState.stats[player.id]?.trumpWins ?? 0}</span><span>TKM galibiyeti: {gameState.stats[player.id]?.rpsWins ?? 0}</span></div>
                  ))}
                </div>
                <div className="result-actions">
                  {isHost ? <button className="rematch-button" onClick={handleRematch}>🔁 AYNI OYUNCULARLA TEKRAR OYNA</button> : <p>Oda sahibinin yeni maçı başlatması bekleniyor.</p>}
                  <button className="menu-return-button" onClick={handleLeaveRoom}>⌂ ANA MENÜYE DÖN</button>
                </div>
              </section>
            )}
            {error && <div className="error-banner game-error"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          </div>
        </div>
      );
    }
    return (
      <div className="app">
        <div className="menu-card">
          <div className="logo-area">
            <span className="suits">♥ ♠ ♣ ♦</span>
            <h1>OYUN LOBİSİ</h1>
            <p>Oyuncuların katılması bekleniyor.</p>
          </div>

          <div className="room-code-box">
            <span>ODA KODU</span>
            <strong>{createdRoom.roomCode}</strong>
          </div>
          <div className="room-rule-badge">
            {createdRoom.playUntilCardsEnd ? "🂠 Kartlar bitene kadar" : `🏆 İlk ${createdRoom.winTarget} tur`}
          </div>
          <button className="lobby-exit-button" onClick={handleLeaveRoom}>🚪 ODADAN ÇIK</button>

          {notice && <div className="notice-banner"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          <div className="lobby-player-list">
            {createdRoom.players.map((player) => (
              <div className="lobby-player" key={player.id}>
                <div className="lobby-player-name">
                  <span>{player.name}{player.connected === false && <small className="reconnecting-label">Yeniden bağlanıyor…</small>}</span>
                  {player.id === createdRoom.hostId && (
                    <strong>👑 Oda Sahibi</strong>
                  )}
                </div>
                <div className="lobby-player-actions">
                  <span className={player.ready ? "ready-status is-ready" : "ready-status"}>
                    {player.ready ? "Hazır" : "Hazır Değil"}
                  </span>
                  {isHost && player.id !== socket.id && (
                    <button className="kick-player-button" onClick={() => handleKickPlayer(player.id)} title={`${player.name} oyuncusunu odadan çıkar`}>
                      ✕ AT
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            className={currentPlayer?.ready ? "ready-button is-ready" : "ready-button"}
            onClick={handleToggleReady}
          >
            {currentPlayer?.ready ? "HAZIR DEĞİLİM" : "HAZIRIM"}
          </button>

          {isHost ? (
            <button
              className="start-button"
              disabled={!canStart}
              onClick={handleStartGame}
            >
              OYUNU BAŞLAT
            </button>
          ) : (
            <p className="host-wait-text">Oda sahibinin oyunu başlatması bekleniyor.</p>
          )}

          {!canStart && isHost && (
            <p className="start-hint">Oda dolduğunda ve herkes hazır olduğunda başlayabilirsin.</p>
          )}

          <p className="online-text">
            {createdRoom.players.length} / {createdRoom.maxPlayers} oyuncu
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="menu-card">
        <div className="logo-area">
          <span className="suits">♥ ♠ ♣ ♦</span>
          <h1>CARDS TO SURVIVE</h1>
          <p>Kartlarını koru. Rakiplerini ele. Son kalan sen ol.</p>
        </div>

        <div className="rules-popover" tabIndex="0">
          <button type="button" className="rules-trigger">📖 KURALLAR <span>Nasıl oynanır?</span></button>
          <div className="rules-panel">
            <h2>Nasıl Oynanır?</h2>
            <ol>
              <li>52 kart oyunculara eşit dağıtılır.</li>
              <li>Her tur kişisel destenden rastgele 4 kart açılır.</li>
              <li>15 saniye içinde bir kart seçersin; diğer üçü destene döner.</li>
              <li>Herkes seçince kartlar açılır ve ♥ ♠ ♣ ♦ arasından rastgele koz belirlenir.</li>
              <li>Koz türündeki en yüksek kart kazanır. Koz yoksa en yüksek değer kazanır.</li>
              <li>Beraberlikte ilgili oyuncular Taş–Kağıt–Makas oynar.</li>
              <li>Turun kazananı ortaya atılan bütün kartları kendi destesine ekler.</li>
            </ol>
            <p>Oda ayarına göre hedef tur sayısına ulaşan veya kartlar bitene kadar oynanan modda son kalan oyuncu maçı kazanır.</p>
          </div>
        </div>

        <div className="form-group">
          <label>Oyuncu Adın</label>

          <input
            type="text"
            placeholder="Adını gir..."
            value={playerName}
            maxLength={16}
            onChange={(e) => setPlayerName(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Oyuncu Sayısı</label>

          <div className="player-count">
            {[2, 3, 4].map((count) => (
              <button
                key={count}
                className={playerCount === count ? "selected" : ""}
                onClick={() => setPlayerCount(count)}
              >
                {count} Kişi
              </button>
            ))}
          </div>
        </div>

        <div className="form-group win-settings">
          <label>Kazanma Koşulu</label>
          <div className="win-target-row">
            <div>
              <input
                type="number"
                min="1"
                max="99"
                value={winTarget}
                disabled={playUntilCardsEnd}
                onChange={(e) => setWinTarget(Math.min(99, Math.max(1, Number(e.target.value))))}
              />
              <span>tur kazanan</span>
            </div>
            <label className="card-end-toggle">
              <input
                type="checkbox"
                checked={playUntilCardsEnd}
                onChange={(e) => setPlayUntilCardsEnd(e.target.checked)}
              />
              <span>Kartlar bitene kadar oyna</span>
            </label>
          </div>
          <p>{playUntilCardsEnd ? "Tur hedefi kapalı; son kart kalana kadar devam edilir." : `${winTarget} tur kazanan oyuncu maçı kazanır.`}</p>
        </div>

        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}

        <button className="main-button" onClick={handleCreateRoom}>
          ODA KUR
        </button>

        <div className="divider">
          <span></span>
          <p>veya</p>
          <span></span>
        </div>

        <div className="join-area">
          <input
            type="text"
            placeholder="ODA KODU"
            value={roomCode}
            maxLength={6}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          />

          <button className="join-button" onClick={handleJoinRoom}>
            KATIL
          </button>
        </div>

        <p className="online-text">● Multiplayer</p>
      </div>
    </div>
  );
}

export default App;
