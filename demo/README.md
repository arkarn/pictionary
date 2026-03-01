# Pictionary MCP App Diagrams

This folder contains the architecture diagrams and flow charts for the Pictionary MCP App.

## Mermaid Diagrams

### Architecture
```mermaid
graph TD
    subgraph Host["Local Machine / Host"]
        Frontend["Frontend UI (React)<br>Excalidraw iframe"]
        Backend["Backend Server<br>MCP + Express"]
    end
    Gemini["Finetuned LLM<br>Ministral-8B"]
    ElevenLabs["ElevenLabs STT"]
    Database["Database<br>Feedback DB"]
    Finetuning["Finetuning<br>Pipeline Scheduled"]

    Frontend -- "MCP HTTP" --> Backend
    Frontend -- "WS /draw-stream" --> Backend
    Frontend -- "WS /stt" --> Backend
    Frontend -- "Submit Rating (👎)" --> Backend
    Backend -- "Store Feedback" --> Database
    Database -- "Next Pipeline" --> Finetuning
    Finetuning -. "Updates Model" .-> Gemini
    Backend -- "Streaming API" --> Gemini
    Backend -- "Proxy WS" --> ElevenLabs
```

### True Streaming Architecture Flow
```mermaid
sequenceDiagram
    participant U as User
    participant UI as App iframe
    participant S as Backend Server
    participant G as Gemini API

    U->>UI: Clicks 'New Game'
    UI->>S: Connect WS /api/draw-stream
    S->>G: generateContentStream()
    G-->>S: Stream Chunks
    S-->>UI: Forward Chunks via WS
    Note over UI: JSON Healing
    UI-->>U: View updates instantly
```

## Excalidraw Files
- `architecture.excalidraw`: High-level architecture showing the interaction between the Host, Frontend iframe, Backend Server, Finetuned LLM, ElevenLabs STT, and the new Feedback/Finetuning DB pipeline.
- `flow-chart.excalidraw`: Sequence flow demonstrating the "True Streaming Architecture" via WebSocket sidechannel.

You can open the above files using the Excalidraw VSCode extension, or simply import them at [excalidraw.com](https://excalidraw.com).

### Shareable Links (Web View)
If you just want to view the images online without downloading or importing:
- **Architecture Diagram**: [View on Excalidraw](https://excalidraw.com/#json=EFhETJ7d8dCjXI7D66A9d,PokBcGDWLUQOLAYyyU4d2A)
- **Streaming Flow Chart**: [View on Excalidraw](https://excalidraw.com/#json=UgDvRMad15CaxbIJZKKS7,oAkeHWMwKiLcDs-L5l_I-A)
