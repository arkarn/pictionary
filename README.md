1. To let AI draw -- freehand / object strokes based drawing
2. Uses Excalidraw MCP -- write in JSON 
    2a. UI is dynamically rendered/streamed even with partial_json (MCP App)
3. Finetune ministral 8B to reduce latency & cost -- maintaining output quality
    3a. Dataset is generated from Claude/Gemini 3.1 to generate JSON output for object
4. System uses user feedback thumbs up/down  -> used for finetuning in next pipeline schedule
5. Uses ElevenLabs STT realtime via websocket
6. Game can be generalized to multiplayer game -- with multiple users just talking to chatroom
7. Generalized idea is to use voice to control game (voice to action mapping)