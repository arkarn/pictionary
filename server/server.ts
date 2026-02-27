/**
 * Pictionary MCP Server
 */
import {
    registerAppResource,
    registerAppTool,
    RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { Mistral } from "@mistralai/mistralai";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pickRandomWord, type WordEntry } from "./words.js";
import { EXCALIDRAW_SYSTEM_PROMPT } from "./excalidraw-prompt.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
    ? path.join(import.meta.dirname, "..", "dist")
    : import.meta.dirname;

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });

// ─── Game State ─────────────────────────────────────────────────────────

interface GameState {
    currentWord: WordEntry;
    attemptsLeft: number;
    revealedLetters: Set<number>;
    won: boolean;
    gameOver: boolean;
}

function createGameState(): GameState {
    return {
        currentWord: pickRandomWord(),
        attemptsLeft: 6,
        revealedLetters: new Set(),
        won: false,
        gameOver: false,
    };
}

function getBlanks(state: GameState): string {
    return state.currentWord.word
        .split("")
        .map((ch, i) => (state.revealedLetters.has(i) ? ch : "_"))
        .join(" ");
}

let gameState = createGameState();

// ─── Mistral Drawing Generation ──────────────────────────────────────────

async function generateDrawing(word: string): Promise<string> {
    const response = await mistral.chat.complete({
        model: "mistral-large-latest",
        messages: [
            { role: "system", content: EXCALIDRAW_SYSTEM_PROMPT },
            {
                role: "user",
                content: `Draw "${word}" using Excalidraw elements. Return ONLY the JSON array, nothing else.`,
            },
        ],
        temperature: 0.7,
        maxTokens: 3000,
    });

    const raw = response.choices?.[0]?.message?.content ?? "[]";
    const text = typeof raw === "string" ? raw : raw.map((c: { text?: string }) => c.text ?? "").join("");

    // Extract JSON array from response (strip any markdown fences)
    const match = text.match(/\[[\s\S]*\]/);
    return match ? match[0] : "[]";
}

// ─── Server ──────────────────────────────────────────────────────────────

const resourceUri = "ui://pictionary/mcp-app.html";

export function createServer(): McpServer {
    const server = new McpServer({ name: "Pictionary MCP App", version: "1.0.0" });

    // ── Tool: draw_pictionary ───────────────────────────────────────────
    registerAppTool(
        server,
        "draw_pictionary",
        {
            title: "Draw Pictionary",
            description:
                "Start a new Pictionary round. The server picks a secret word, generates an Excalidraw drawing with Mistral, and streams it to the game UI. The player then guesses the word.",
            inputSchema: {},
            _meta: { ui: { resourceUri } },
        },
        async (): Promise<CallToolResult> => {
            gameState = createGameState();
            const word = gameState.currentWord.word;
            console.log(`[Pictionary] New game: "${word}" (${gameState.currentWord.category})`);

            let elements = "[]";
            try {
                elements = await generateDrawing(word);
                console.log(`[Pictionary] Drawing generated (${elements.length} chars)`);
            } catch (err) {
                console.error("[Pictionary] Mistral error:", err);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "drawing_complete",
                            wordLength: word.length,
                            category: gameState.currentWord.category,
                            blanks: getBlanks(gameState),
                            attemptsLeft: gameState.attemptsLeft,
                            elements,
                        }),
                    },
                ],
            };
        }
    );

    // ── Tool: check_guess (UI-only) ────────────────────────────────────
    registerAppTool(
        server,
        "check_guess",
        {
            title: "Check Guess",
            description: "Check the player's guess against the current word.",
            inputSchema: {
                guess: z.string().describe("The player's guess"),
            },
            _meta: { ui: { resourceUri, visibility: ["app"] } },
        },
        async (args): Promise<CallToolResult> => {
            const guess = (args.guess as string).toLowerCase().trim();
            const correct = guess === gameState.currentWord.word.toLowerCase();

            if (correct) {
                gameState.won = true;
                for (let i = 0; i < gameState.currentWord.word.length; i++) {
                    gameState.revealedLetters.add(i);
                }
            } else {
                gameState.attemptsLeft--;
                // Reveal one random hidden letter as a hint
                const hidden = [];
                for (let i = 0; i < gameState.currentWord.word.length; i++) {
                    if (!gameState.revealedLetters.has(i)) hidden.push(i);
                }
                if (hidden.length > 0) {
                    gameState.revealedLetters.add(hidden[Math.floor(Math.random() * hidden.length)]);
                }
            }

            if (gameState.attemptsLeft <= 0) {
                gameState.gameOver = true;
                for (let i = 0; i < gameState.currentWord.word.length; i++) {
                    gameState.revealedLetters.add(i);
                }
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            correct,
                            blanks: getBlanks(gameState),
                            attemptsLeft: gameState.attemptsLeft,
                            won: gameState.won,
                            gameOver: gameState.gameOver,
                            word: gameState.won || gameState.gameOver ? gameState.currentWord.word : undefined,
                        }),
                    },
                ],
            };
        }
    );

    // ── Tool: get_game_state (UI-only) ─────────────────────────────────
    registerAppTool(
        server,
        "get_game_state",
        {
            title: "Get Game State",
            description: "Get the current game state.",
            inputSchema: {},
            _meta: { ui: { resourceUri, visibility: ["app"] } },
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            wordLength: gameState.currentWord.word.length,
                            category: gameState.currentWord.category,
                            blanks: getBlanks(gameState),
                            attemptsLeft: gameState.attemptsLeft,
                            won: gameState.won,
                            gameOver: gameState.gameOver,
                        }),
                    },
                ],
            };
        }
    );

    // ── Resource: bundled React UI ─────────────────────────────────────
    registerAppResource(
        server,
        resourceUri,
        resourceUri,
        { mimeType: RESOURCE_MIME_TYPE, description: "Pictionary Game UI" },
        async (): Promise<ReadResourceResult> => {
            const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
            return {
                contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
            };
        }
    );

    return server;
}
