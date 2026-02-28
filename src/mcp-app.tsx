/**
 * Pictionary MCP App — React UI
 *
 * Two-panel layout:
 * - Left: Excalidraw canvas showing the drawing (progressively rendered)
 * - Right: Game panel with word blanks, guess input, and status
 *
 * Uses MCP App SDK's ontoolinputpartial for progressive rendering:
 * As the LLM streams Excalidraw elements JSON, partial (healed) JSON
 * is fed to the canvas, making the drawing appear stroke-by-stroke.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "./global.css";

// ─── Filler words to skip when matching STT output ───────────────────
const FILLER_WORDS = new Set([
    "the", "a", "an", "is", "it", "i", "me", "my", "we", "he", "she",
    "and", "or", "but", "to", "of", "in", "on", "at", "for", "so",
    "um", "uh", "like", "just", "that", "this", "with", "do", "does",
    "was", "are", "be", "been", "not", "no", "yes", "yeah", "ok",
    "its", "am", "if", "as", "by", "up", "oh", "ah", "hmm",
]);

// ─── useAudioGuess Hook ─────────────────────────────────────────────
interface AudioGuessOpts {
    wordLength: number;
    onWordMatch: (word: string) => void;
    enabled: boolean;
}

function useAudioGuess({ wordLength, onWordMatch, enabled }: AudioGuessOpts) {
    const [isListening, setIsListening] = useState(false);
    const [liveTranscript, setLiveTranscript] = useState("");
    const [audioError, setAudioError] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const matchedRef = useRef(false);
    const enabledRef = useRef(enabled);
    const timeoutRef = useRef<number | null>(null);

    // Keep enabledRef in sync
    useEffect(() => { enabledRef.current = enabled; }, [enabled]);

    const cleanup = useCallback(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
            audioCtxRef.current.close().catch(() => { });
            audioCtxRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsListening(false);
        setLiveTranscript("");
    }, []);

    const start = useCallback(async () => {
        setAudioError(null);
        matchedRef.current = false;

        try {
            // 1. Request mic
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // 2. Open WebSocket to our backend proxy instead of direct to ElevenLabs
            // The MCP app is hosted in an iframe by basic-host on port 8081, but the 
            // backend MCP server is running on port 3001. So we must hardcode the port.
            const wsUrl = `ws://localhost:3001/api/stt`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("[AudioGuess] WebSocket connected");
                setIsListening(true);

                // Auto-stop after 3 minutes
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                timeoutRef.current = window.setTimeout(() => {
                    console.log("[AudioGuess] 3 minute timeout reached, stopping.");
                    cleanup();
                }, 180000);

                // 3. Start capturing & sending audio
                const audioCtx = new AudioContext({ sampleRate: 16000 });
                audioCtxRef.current = audioCtx;
                const source = audioCtx.createMediaStreamSource(stream);
                const processor = audioCtx.createScriptProcessor(4096, 1, 1);
                processorRef.current = processor;

                source.connect(processor);
                processor.connect(audioCtx.destination);

                processor.onaudioprocess = (e) => {
                    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
                    const float32 = e.inputBuffer.getChannelData(0);
                    const int16 = new Int16Array(float32.length);
                    for (let i = 0; i < float32.length; i++) {
                        const s = Math.max(-1, Math.min(1, float32[i]));
                        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    const bytes = new Uint8Array(int16.buffer);
                    let binary = "";
                    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                    const b64 = btoa(binary);
                    wsRef.current.send(JSON.stringify({
                        message_type: "input_audio_chunk",
                        audio_base_64: b64,
                    }));
                };
            };

            ws.onmessage = async (event) => {
                if (matchedRef.current) return;

                try {
                    let textData = event.data;
                    if (textData instanceof Blob) {
                        textData = await textData.text();
                    }
                    const msg = JSON.parse(textData);
                    console.log("[AudioGuess] STT message:", msg);

                    // Different providers use different keys. ElevenLabs might use 'type' or 'message_type'
                    const isTranscript = msg.message_type === "partial_transcript" ||
                        msg.message_type === "committed_transcript" ||
                        msg.type === "partial_transcript" ||
                        msg.type === "committed_transcript" ||
                        msg.type === "realtimeResponse" ||
                        msg.text !== undefined;

                    if (isTranscript) {
                        const text = (msg.text || msg.transcript || "").trim();
                        if (text) {
                            setLiveTranscript(text);
                            // Submit the entire transcribed segment to the backend
                            if (enabledRef.current) {
                                console.log(`[AudioGuess] Submitting phrase: "${text}"`);
                                onWordMatch(text);
                            }
                        }
                    }

                    if (msg.message_type && msg.message_type.includes("error")) {
                        console.error("[AudioGuess] ElevenLabs error:", msg);
                        setAudioError(msg.message_type);
                    }
                } catch (err) {
                    console.error("[AudioGuess] JSON parse error on message:", err, event.data);
                }
            };

            ws.onclose = (e) => {
                console.log("[AudioGuess] WebSocket closed:", e.code, e.reason);
                cleanup();
            };

            ws.onerror = () => {
                setAudioError("WebSocket connection error");
                cleanup();
            };
        } catch (err: any) {
            console.error("[AudioGuess] Start error:", err);
            setAudioError(err.message || "Microphone error");
            cleanup();
        }
    }, [wordLength, onWordMatch, cleanup]);

    // Auto-cleanup if disabled externally
    useEffect(() => {
        if (!enabled && isListening) cleanup();
    }, [enabled, isListening, cleanup]);

    // Cleanup on unmount
    useEffect(() => cleanup, [cleanup]);

    return { isListening, liveTranscript, audioError, start, stop: cleanup };
}

// ─── Types ──────────────────────────────────────────────────────────────

interface DrawInput {
    elements?: string;
}

interface GameState {
    wordLength: number;
    category: string;
    blanks: string;
    attemptsLeft: number;
    won: boolean;
    gameOver: boolean;
}

interface GuessResult {
    correct: boolean;
    blanks: string;
    attemptsLeft: number;
    won: boolean;
    gameOver: boolean;
    word?: string;
}

// ─── MCP App Wrapper ────────────────────────────────────────────────────

function McpAppWrapper() {
    const [toolInputs, setToolInputs] = useState<DrawInput | null>(null);
    const [toolInputsPartial, setToolInputsPartial] = useState<DrawInput | null>(null);
    const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
    const [hostContext, setHostContext] = useState<McpUiHostContext | null>(null);

    const { app, error } = useApp({
        appInfo: { name: "Pictionary", version: "1.0.0" },
        capabilities: {},
        onAppCreated: (app) => {
            // Complete tool input (streaming finished)
            app.ontoolinput = (params) => {
                setToolInputs(params.arguments as DrawInput);
                setToolInputsPartial(null);
            };
            // Partial tool input (streaming in progress — healed JSON)
            app.ontoolinputpartial = (params) => {
                setToolInputsPartial(params.arguments as DrawInput);
            };
            // Tool execution result
            app.ontoolresult = (params) => {
                setToolResult(params as CallToolResult);
            };
            // Host context changes
            app.onhostcontextchanged = (params) => {
                setHostContext((prev) => ({ ...prev, ...params }));
            };
            app.ontoolcancelled = (params) => {
                console.info("Tool cancelled:", params.reason);
            };
            app.onerror = console.error;
        },
    });

    useHostStyles(app);

    useEffect(() => {
        if (app) {
            const ctx = app.getHostContext();
            if (ctx) setHostContext(ctx);
        }
    }, [app]);

    if (error) return <div style={{ padding: 20, color: "#ef4444" }}>Error: {error.message}</div>;
    if (!app) return <div style={{ padding: 20, color: "#8b99b5" }}>Connecting...</div>;

    return (
        <PictionaryApp
            app={app}
            toolInputs={toolInputs}
            toolInputsPartial={toolInputsPartial}
            toolResult={toolResult}
            hostContext={hostContext}
        />
    );
}

// ─── Pictionary Game ────────────────────────────────────────────────────

interface PictionaryProps {
    app: App;
    toolInputs: DrawInput | null;
    toolInputsPartial: DrawInput | null;
    toolResult: CallToolResult | null;
    hostContext: McpUiHostContext | null;
}

function PictionaryApp({ app, toolInputs, toolInputsPartial, toolResult, hostContext }: PictionaryProps) {
    const [gameState, setGameState] = useState<GameState | null>(null);
    const [guess, setGuess] = useState("");
    const [feedback, setFeedback] = useState<{ type: "wrong" | "hint" | "success"; text: string } | null>(null);
    // Store fully-converted Excalidraw elements (already processed by convertToExcalidrawElements)
    const [excalidrawElements, setExcalidrawElements] = useState<any[]>([]);
    const [canvasKey, setCanvasKey] = useState(0);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isNewGameLoading, setIsNewGameLoading] = useState(false);
    const [audioMode, setAudioMode] = useState(false);

    const animationRef = useRef<number | null>(null);
    const excalidrawApiRef = useRef<any>(null);

    // Helper: parse → filter → convert → animate elements pushing one by one
    const applyElements = useCallback((rawJson: any[]) => {
        const valid = rawJson.filter(
            (el: any) => el.type && !["cameraUpdate", "delete", "restoreCheckpoint"].includes(el.type)
        );
        if (valid.length > 0) {
            try {
                const full = convertToExcalidrawElements(valid);
                console.log("[Pictionary UI] animateElements start:", full.length, "elements");

                // Clear any existing animation
                if (animationRef.current) clearInterval(animationRef.current);

                // Reset canvas state
                setExcalidrawElements([]);
                setCanvasKey(k => k + 1); // remount once to clear
                setIsStreaming(true);

                let currentIndex = 0;

                // Push one element at a time (e.g., every 300ms) to simulate drawing
                animationRef.current = window.setInterval(() => {
                    if (currentIndex < full.length) {
                        const nextElements = full.slice(0, currentIndex + 1);
                        setExcalidrawElements(nextElements);
                        if (excalidrawApiRef.current) {
                            excalidrawApiRef.current.updateScene({ elements: nextElements });
                        }
                        currentIndex++;
                    } else {
                        if (animationRef.current) clearInterval(animationRef.current);
                        setIsStreaming(false);
                        console.log("[Pictionary UI] animateElements complete");
                    }
                }, 300); // 300ms per shape

            } catch (e) {
                console.error("[Pictionary UI] convertToExcalidrawElements failed:", e);
                setIsStreaming(false);
            }
        }
    }, []);

    // Cleanup animation on unmount
    useEffect(() => {
        return () => {
            if (animationRef.current) clearInterval(animationRef.current);
        };
    }, []);

    // Parse elements from toolInputs (streaming path)
    useEffect(() => {
        const rawElements = toolInputsPartial?.elements || toolInputs?.elements;
        if (rawElements) {
            try {
                const parsed = JSON.parse(rawElements);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    applyElements(parsed);
                }
            } catch { /* partial JSON, ignore */ }
            setIsStreaming(!!toolInputsPartial);
        }
    }, [toolInputs, toolInputsPartial]);

    // Parse game state AND elements from tool result (host LLM finishes drawing)
    useEffect(() => {
        if (!toolResult) return;
        try {
            const textContent = toolResult.content?.find((c: any) => c.type === "text");
            if (textContent && "text" in textContent) {
                const textStr = (textContent as any).text;
                const data = JSON.parse(textStr);

                if (data.wordLength) {
                    setGameState({
                        wordLength: data.wordLength,
                        category: data.category,
                        blanks: data.blanks,
                        attemptsLeft: data.attemptsLeft,
                        won: data.won ?? false,
                        gameOver: data.gameOver ?? false,
                    });
                    setFeedback(null);
                    setGuess("");
                }
                if (data.elements) {
                    try {
                        const parsed = JSON.parse(data.elements);
                        console.log("[Pictionary UI] toolResult elements:", parsed.length);
                        if (Array.isArray(parsed)) applyElements(parsed);
                    } catch (e) {
                        console.error("[Pictionary UI] Failed to parse elements JSON:", e);
                    }
                } else {
                    console.warn("[Pictionary UI] No elements in toolResult. Keys:", Object.keys(data));
                }
            }
        } catch (e) {
            console.error("[Pictionary UI] Failed to parse toolResult:", e);
            setIsNewGameLoading(false);
        }
    }, [toolResult, applyElements]);

    // Fetch initial game state on mount
    useEffect(() => {
        (async () => {
            try {
                const result = await app.callServerTool({ name: "get_game_state", arguments: {} });
                const text = result.content?.find((c: any) => c.type === "text");
                if (text && "text" in text) {
                    const data = JSON.parse(text.text);
                    setGameState({
                        wordLength: data.wordLength,
                        category: data.category,
                        blanks: data.blanks,
                        attemptsLeft: data.attemptsLeft,
                        won: data.won ?? false,
                        gameOver: data.gameOver ?? false,
                    });
                }
            } catch {
                // Server may not have a game yet
            }
        })();
    }, [app]);

    const submitGuess = useCallback(async (word: string): Promise<boolean> => {
        if (!word.trim() || !gameState || gameState.won || gameState.gameOver) return false;

        try {
            const result = await app.callServerTool({
                name: "check_guess",
                arguments: { guess: word.trim() },
            });
            const text = result.content?.find((c: any) => c.type === "text");
            if (text && "text" in text) {
                const data: GuessResult = JSON.parse(text.text);
                setGameState((prev) =>
                    prev
                        ? {
                            ...prev,
                            blanks: data.blanks,
                            attemptsLeft: data.attemptsLeft,
                            won: data.won,
                            gameOver: data.gameOver,
                        }
                        : prev
                );

                if (data.correct) {
                    setFeedback({ type: "success", text: `🎉 "${word.trim()}" is correct! Great job!` });
                    return true;
                } else {
                    setFeedback({
                        type: "wrong",
                        text: `"${word.trim()}" is not correct!`,
                    });
                }
            }
        } catch (e) {
            console.error("Guess error:", e);
        }
        return false;
    }, [app, gameState]);

    const handleGuess = useCallback(async () => {
        if (!guess.trim()) return;
        await submitGuess(guess.trim());
        setGuess("");
    }, [guess, submitGuess]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter") handleGuess();
        },
        [handleGuess]
    );

    // Audio guess: when a matching word is spoken, auto-submit it
    const handleAudioWordMatch = useCallback(async (word: string) => {
        setGuess(word);
        const wasCorrect = await submitGuess(word);
        if (wasCorrect) {
            setAudioMode(false); // stop mic on correct answer
        } else {
            // Give visual feedback but let the microphone keep running
            setGuess("");
        }
    }, [submitGuess]);

    const audioGuess = useAudioGuess({
        wordLength: gameState?.wordLength ?? 0,
        onWordMatch: handleAudioWordMatch,
        enabled: audioMode && !!(gameState && !gameState.won && !gameState.gameOver),
    });

    const toggleAudio = useCallback(() => {
        if (audioGuess.isListening) {
            audioGuess.stop();
            setAudioMode(false);
        } else {
            setAudioMode(true);
            audioGuess.start();
        }
    }, [audioGuess]);

    const handleNewGame = useCallback(async () => {
        if (isNewGameLoading) return;
        setIsNewGameLoading(true);

        // Reset audio state and timer
        if (audioGuess.isListening) {
            audioGuess.stop();
        }
        setAudioMode(false);

        if (animationRef.current) clearInterval(animationRef.current);
        setExcalidrawElements([]);
        setFeedback(null);
        setGuess("");
        setGameState(null);

        try {
            // Call tool directly again now that generation is server-side
            const result = await app.callServerTool({ name: "draw_pictionary", arguments: {} });

            const textContent = result.content?.find((c: any) => c.type === "text");
            if (textContent && "text" in textContent) {
                const textStr = (textContent as any).text;
                try {
                    const data = JSON.parse(textStr);
                    if (data.wordLength) {
                        setGameState({
                            wordLength: data.wordLength,
                            category: data.category,
                            blanks: data.blanks,
                            attemptsLeft: data.attemptsLeft,
                            won: data.won ?? false,
                            gameOver: data.gameOver ?? false,
                        });
                    }
                    if (data.elements) {
                        const parsed = JSON.parse(data.elements);
                        if (Array.isArray(parsed)) applyElements(parsed);
                    }
                } catch (e) {
                    console.error("[Pictionary UI] Failed parsing new game result:", e);
                }
            }
            setIsNewGameLoading(false);
        } catch (e) {
            console.error("[Pictionary UI] Failed to call new game tool:", e);
            setIsNewGameLoading(false);
        }
    }, [app, isNewGameLoading, applyElements]);

    const isGameActive = gameState && !gameState.won && !gameState.gameOver;
    const MAX_ATTEMPTS = 6;

    return (
        <div className="app-container">
            <div className="main-content">
                {/* Left: Drawing Canvas */}
                <div className="canvas-panel">
                    {isStreaming && (
                        <div className="streaming-indicator">
                            <span className="streaming-dot" />
                            Drawing...
                        </div>
                    )}
                    {isStreaming || excalidrawElements.length > 0 ? (
                        <div className="canvas-wrapper">
                            <Excalidraw
                                key={canvasKey}
                                excalidrawAPI={(api) => excalidrawApiRef.current = api}
                                initialData={{
                                    elements: excalidrawElements,
                                    appState: {
                                        viewBackgroundColor: "#f3f4f6",
                                        theme: "light",
                                        viewModeEnabled: true,
                                        zenModeEnabled: true,
                                        gridModeEnabled: false,
                                    },
                                    scrollToContent: true,
                                }}
                                viewModeEnabled={true}
                                zenModeEnabled={true}
                                gridModeEnabled={false}
                                theme="light"
                                UIOptions={{
                                    canvasActions: {
                                        changeViewBackgroundColor: false,
                                        clearCanvas: false,
                                        export: false,
                                        loadScene: false,
                                        saveAsImage: false,
                                        saveToActiveFile: false,
                                        toggleTheme: false,
                                    },
                                }}
                            />
                        </div>
                    ) : (
                        <div className="canvas-placeholder">
                            <div className="icon">🎨</div>
                            <p>Waiting for the drawing...</p>
                            <button
                                className="btn-primary"
                                onClick={handleNewGame}
                                disabled={isNewGameLoading}
                                style={{ marginTop: '1rem' }}
                            >
                                {isNewGameLoading ? "⏳ Starting..." : "START NEW ROUND"}
                            </button>
                        </div>
                    )}
                </div>

                {/* Right: Game Panel */}
                <div className="game-panel">
                    {/* Panel header with New Game button always visible */}
                    <div className="panel-header">
                        <span className="panel-title">Guess the word</span>
                        <button
                            id="new-game-btn"
                            className={`btn-icon ${isNewGameLoading ? "spinning" : ""}`}
                            onClick={handleNewGame}
                            disabled={isNewGameLoading}
                            title="New Game"
                        >
                            {isNewGameLoading ? "⏳" : "🔄"}
                        </button>
                    </div>
                    {gameState ? (
                        <>
                            {/* Word Info */}
                            <div className="info-card">
                                <div className="category-badge">{gameState.category}</div>
                                <div className="word-blanks">{gameState.blanks}</div>
                                <div className="attempts-bar">
                                    <span className="attempts-label">
                                        Attempts: {gameState.attemptsLeft}/{MAX_ATTEMPTS}
                                    </span>
                                    <div className="attempts-dots">
                                        {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
                                            <div
                                                key={i}
                                                className={`attempt-dot ${i >= gameState.attemptsLeft ? "used" : ""}`}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Win / Game Over */}
                            {gameState.won ? (
                                <div className="overlay-card win">
                                    <div className="overlay-emoji">🎉</div>
                                    <div className="overlay-title" style={{ color: "var(--accent-green)" }}>
                                        You got it!
                                    </div>
                                    <div className="overlay-word">
                                        The word was <span>{gameState.blanks.replace(/ /g, "")}</span>
                                    </div>
                                    <button className="btn btn-success" onClick={handleNewGame}>
                                        Play Again
                                    </button>
                                </div>
                            ) : gameState.gameOver ? (
                                <div className="overlay-card lose">
                                    <div className="overlay-emoji">😔</div>
                                    <div className="overlay-title" style={{ color: "var(--accent-red)" }}>
                                        Game Over
                                    </div>
                                    <div className="overlay-word">
                                        The word was <span>{gameState.blanks.replace(/ /g, "")}</span>
                                    </div>
                                    <button className="btn btn-success" onClick={handleNewGame}>
                                        Try Again
                                    </button>
                                </div>
                            ) : (
                                <>
                                    {/* Guess Input */}
                                    <div className="guess-section">
                                        <div className="guess-form">
                                            <input
                                                type="text"
                                                className="guess-input"
                                                placeholder={audioGuess.isListening ? "Listening..." : "Type your guess..."}
                                                value={guess}
                                                onChange={(e) => setGuess(e.target.value)}
                                                onKeyDown={handleKeyDown}
                                                disabled={!isGameActive}
                                                autoFocus
                                            />
                                            <button
                                                className="btn btn-primary"
                                                onClick={handleGuess}
                                                disabled={!guess.trim() || !isGameActive}
                                            >
                                                Guess
                                            </button>
                                            <button
                                                className={`mic-btn ${audioGuess.isListening ? "active" : ""}`}
                                                onClick={toggleAudio}
                                                disabled={!isGameActive}
                                                title={audioGuess.isListening ? "Stop listening" : "Voice guess"}
                                            >
                                                {audioGuess.isListening ? "🔴" : "🎙️"}
                                            </button>
                                        </div>
                                        {audioGuess.isListening && audioGuess.liveTranscript && (
                                            <div className="live-transcript">
                                                <span className="transcript-dot" />
                                                {audioGuess.liveTranscript}
                                            </div>
                                        )}
                                        {audioGuess.audioError && (
                                            <div className="feedback wrong">{audioGuess.audioError}</div>
                                        )}
                                        {feedback && (
                                            <div className={`feedback ${feedback.type}`}>{feedback.text}</div>
                                        )}
                                    </div>
                                </>
                            )}
                        </>
                    ) : (
                        <div className="waiting-card">
                            <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
                            <p>Ready to play!</p>
                            <p style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)" }}>
                                Hit 🔄 to start, or ask the model to draw
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Mount ──────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <McpAppWrapper />
    </StrictMode>
);
