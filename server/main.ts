/**
 * Entry point for the Pictionary MCP server.
 * Supports streamable-http (default) and stdio transports.
 */
import "dotenv/config";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { WebSocketServer, WebSocket as NodeWebSocket, RawData } from "ws";
import { createServer } from "./server.js";

async function startStreamableHTTPServer(): Promise<void> {
    const port = parseInt(process.env.PORT ?? "3001", 10);
    const app = createMcpExpressApp({ host: "0.0.0.0" });
    app.use(cors());

    // Create the WebSocket Server for our STT Proxy
    // We attach it to the Express HTTP Server on the 'upgrade' event
    const wss = new WebSocketServer({ noServer: true });

    // Handle incoming WS connections to our proxy
    wss.on("connection", (clientWs) => {
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsKey) {
            console.error("[STT Proxy] No API key found");
            clientWs.close(1011, "Server configured incorrectly");
            return;
        }

        const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&language_code=en`;

        // Connect to ElevenLabs with the secret key header
        const backendWs = new NodeWebSocket(url, {
            headers: { "xi-api-key": elevenLabsKey }
        });

        // 1. Browser -> Proxy -> ElevenLabs
        clientWs.on("message", (msg, isBinary) => {
            if (backendWs.readyState === NodeWebSocket.OPEN) {
                backendWs.send(isBinary ? msg : msg.toString());
            }
        });

        // 2. ElevenLabs -> Proxy -> Browser
        backendWs.on("message", (msg, isBinary) => {
            if (clientWs.readyState === NodeWebSocket.OPEN) {
                clientWs.send(isBinary ? msg : msg.toString());
            }
        });

        // Error handling & Cleanup
        backendWs.on("error", console.error);
        clientWs.on("error", console.error);

        backendWs.on("close", () => clientWs.close());
        clientWs.on("close", () => backendWs.close());
    });

    app.all("/mcp", async (req: Request, res: Response) => {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        res.on("close", () => {
            transport.close().catch(() => { });
            server.close().catch(() => { });
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error("MCP error:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });

    const httpServer = app.listen(port, () => {
        console.log(`🎨 Pictionary MCP server listening on http://localhost:${port}/mcp`);
        console.log(`🎙️  STT Proxy ready at ws://localhost:${port}/api/stt`);
    });

    // @ts-ignore - types are tricky here between Express and raw HTTP
    httpServer.on("upgrade", (request, socket, head) => {
        if (request.url === "/api/stt") {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request);
            });
        }
    });

    httpServer.on('error', (err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });

    const shutdown = () => {
        console.log("\nShutting down...");
        httpServer.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

async function startStdioServer(): Promise<void> {
    await createServer().connect(new StdioServerTransport());
}

async function main() {
    if (process.argv.includes("--stdio")) {
        await startStdioServer();
    } else {
        await startStreamableHTTPServer();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

// Keep the process alive
setInterval(() => { }, 1000 * 60 * 60);
