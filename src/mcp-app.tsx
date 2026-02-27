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
import { StrictMode, useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "./global.css";

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

function PictionaryApp({ app, toolInputs, toolInputsPartial, toolResult }: PictionaryProps) {
    const [gameState, setGameState] = useState<GameState | null>(null);
    const [guess, setGuess] = useState("");
    const [feedback, setFeedback] = useState<{ type: "wrong" | "hint"; text: string } | null>(null);
    const [excalidrawElements, setExcalidrawElements] = useState<any[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);

    // Parse Excalidraw elements — from toolResult (server-generated) or toolInputs (LLM-generated streaming)
    useEffect(() => {
        // Prefer elements from tool inputs (streaming/LLM path)
        const rawElements = toolInputsPartial?.elements || toolInputs?.elements;
        if (rawElements) {
            try {
                const parsed = JSON.parse(rawElements);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    const validElements = parsed.filter(
                        (el: any) => el.type && !["cameraUpdate", "delete", "restoreCheckpoint"].includes(el.type)
                    );
                    setExcalidrawElements(validElements);
                }
            } catch { /* partial JSON, ignore */ }
            setIsStreaming(!!toolInputsPartial);
        }
    }, [toolInputs, toolInputsPartial]);

    // Parse game state AND elements from tool result (server-side Mistral generation)
    useEffect(() => {
        if (!toolResult) return;
        try {
            const text = toolResult.content?.find((c: any) => c.type === "text");
            if (text && "text" in text) {
                const data = JSON.parse((text as any).text);
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
                // Elements returned from server (Mistral-generated)
                if (data.elements) {
                    try {
                        const parsed = JSON.parse(data.elements);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            const valid = parsed.filter(
                                (el: any) => el.type && !["cameraUpdate", "delete", "restoreCheckpoint"].includes(el.type)
                            );
                            setExcalidrawElements(valid);
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    }, [toolResult]);

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

    const handleGuess = useCallback(async () => {
        if (!guess.trim() || !gameState || gameState.won || gameState.gameOver) return;

        try {
            const result = await app.callServerTool({
                name: "check_guess",
                arguments: { guess: guess.trim() },
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
                    setFeedback(null);
                } else {
                    setFeedback({
                        type: "wrong",
                        text: `"${guess.trim()}" is not correct!`,
                    });
                }
            }
        } catch (e) {
            console.error("Guess error:", e);
        }
        setGuess("");
    }, [app, guess, gameState]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter") handleGuess();
        },
        [handleGuess]
    );

    const handleNewGame = useCallback(async () => {
        setExcalidrawElements([]);
        setFeedback(null);
        setGuess("");
        setGameState(null);

        // Send a message to the host to trigger a new draw_pictionary call
        try {
            await app.sendMessage({
                role: "user",
                content: [{ type: "text", text: "Start a new round of pictionary! Pick a word and draw it." }],
            });
        } catch (e) {
            console.error("Failed to request new game:", e);
        }
    }, [app]);

    const isGameActive = gameState && !gameState.won && !gameState.gameOver;
    const MAX_ATTEMPTS = 6;

    return (
        <div className="app-container">
            <header className="header">
                <h1>Pictionary</h1>
                <p className="subtitle">AI draws, you guess!</p>
            </header>

            <div className="main-content">
                {/* Left: Drawing Canvas */}
                <div className="canvas-panel">
                    {excalidrawElements.length > 0 ? (
                        <>
                            {isStreaming && (
                                <div className="streaming-indicator">
                                    <span className="streaming-dot" />
                                    Drawing...
                                </div>
                            )}
                            <Excalidraw
                                initialData={{
                                    elements: excalidrawElements,
                                    appState: {
                                        viewBackgroundColor: "#1a2340",
                                        theme: "dark",
                                        viewModeEnabled: true,
                                        zenModeEnabled: true,
                                        gridModeEnabled: false,
                                    },
                                    scrollToContent: true,
                                }}
                                viewModeEnabled={true}
                                zenModeEnabled={true}
                                gridModeEnabled={false}
                                theme="dark"
                            />
                        </>
                    ) : (
                        <div className="canvas-placeholder">
                            <div className="icon">🎨</div>
                            <p>Waiting for the AI to draw...</p>
                            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                Ask the model to "start a round of pictionary"
                            </p>
                        </div>
                    )}
                </div>

                {/* Right: Game Panel */}
                <div className="game-panel">
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
                                                placeholder="Type your guess..."
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
                                        </div>
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
                            <p>Waiting for a new round to start...</p>
                            <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                                The AI will pick a word and start drawing
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
