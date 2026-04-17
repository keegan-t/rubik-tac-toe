import { startServer } from "./index";

const { port } = startServer(8080);
console.log(`WebSocket server listening on ws://localhost:${port}`);
