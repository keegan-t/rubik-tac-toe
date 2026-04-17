import express from "express";
import { createServer } from "http";
import { join } from "path";
import { startServer } from "./index";

const app = express();
const httpServer = createServer(app);

const clientDir = join(__dirname, "../client");
app.use(express.static(clientDir));
app.get("/{*path}", (_req, res) => res.sendFile(join(clientDir, "index.html")));

startServer(httpServer);

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
httpServer.listen(port, () => {
    console.log(`Listening on :${port}`);
});
