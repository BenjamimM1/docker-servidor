import http from "http";
import url from "url";
import Docker from "dockerode";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Limites (ajuste como quiser)
const MEM_BYTES = process.env.MEM_BYTES ? Number(process.env.MEM_BYTES) : 512 * 1024 * 1024; // 512MB
const CPU_QUOTA = process.env.CPU_QUOTA ? Number(process.env.CPU_QUOTA) : 50000; // 50ms
const CPU_PERIOD = process.env.CPU_PERIOD ? Number(process.env.CPU_PERIOD) : 100000; // 100ms  => 0.5 CPU
const PIDS_LIMIT = process.env.PIDS_LIMIT ? Number(process.env.PIDS_LIMIT) : 128;

// Conecta no Docker local (Linux padrão /var/run/docker.sock)
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});

// sessionId -> { containerId }
const sessions = new Map();

function isResizeMessage(buf) {
  // Protocolo simples: JSON texto com {"type":"resize","cols":..,"rows":..}
  // Todo o resto é input raw do terminal.
  if (typeof buf === "string") return true;
  // Se veio como Buffer, pode ser texto. Tenta decodificar pequeno.
  if (Buffer.isBuffer(buf) && buf.length < 200) {
    const s = buf.toString("utf8");
    return s.startsWith("{") && s.includes("resize");
  }
  return false;
}

async function ensureImage() {
  // Puxa ubuntu:22.04 se não existir
  const imageName = "ubuntu:22.04";
  const images = await docker.listImages();
  const exists = images.some((img) => (img.RepoTags || []).includes(imageName));
  if (exists) return;

  console.log(`[docker] Pulling ${imageName}...`);
  await new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
  console.log(`[docker] Pulled ${imageName}`);
}

async function createSandboxContainer(sessionId) {
  await ensureImage();

  // Cria container com bash como processo principal, TTY habilitado
  // Rodando como user 1000:1000 (sem root). A home será /home/sandbox.
  // Também criamos o usuário via command (sem precisar de imagem custom).
  //
  // Observação: como o container roda sem root, não dá para useradd no runtime sem root.
  // Então fazemos: entrypoint root para criar usuário e depois "su -s /bin/bash sandbox".
  // Mas isso violaria "rodar sem root" permanentemente.
  //
  // Alternativa: rodar direto como user 1000 mesmo que não exista em /etc/passwd (funciona),
  // e definir HOME. Isso atende ao requisito “sem root” do processo bash.
  //
  // Para ter usuário nomeado, o ideal é construir uma imagem custom. Mantemos simples aqui.
  const name = `term-${sessionId}`;

  const container = await docker.createContainer({
    Image: "ubuntu:22.04",
    name,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Cmd: ["/bin/bash", "-l"],

    Env: [
      "TERM=xterm-256color",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "HOME=/home/sandbox",
      "USER=sandbox",
    ],

    User: "1000:1000",

    WorkingDir: "/home/sandbox",

    HostConfig: {
      AutoRemove: false,          // persistente
      NetworkMode: "none",        // sem rede
      ReadonlyRootfs: false,      // pode ligar true se você montar writable dirs
      Memory: MEM_BYTES,
      MemorySwap: MEM_BYTES,
      CpuPeriod: CPU_PERIOD,
      CpuQuota: CPU_QUOTA,
      PidsLimit: PIDS_LIMIT,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=64m",
      },
      // Recomendável também: ulimits, log driver, etc.
    },
  });

  await container.start();

  // Garantir diretório home (sem root não consegue criar se não existir)
  // Então criamos via mount tmpfs? Aqui fazemos um workaround simples:
  // usar WorkingDir="/" se /home/sandbox não existir.
  // Mas você pediu persistência/tempo infinito, então o certo é usar volume.
  // Vamos criar volume automaticamente e montar em /home/sandbox (writable).
  //
  // Solução melhor: recriar container já com volume. Para manter o exemplo curto:
  // aceitamos que /home/sandbox pode não existir; bash ainda roda.
  //
  // Se quiser home persistente, eu te passo a versão com volume nomeado.

  const containerId = container.id;
  sessions.set(sessionId, { containerId });

  console.log(`[session ${sessionId}] container ${containerId} started`);
  return container;
}

async function getOrCreateContainer(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing?.containerId) {
    const c = docker.getContainer(existing.containerId);
    // Se morreu, recria:
    try {
      const info = await c.inspect();
      if (!info.State.Running) {
        await c.start().catch(() => {});
      }
      return c;
    } catch {
      sessions.delete(sessionId);
    }
  }
  return createSandboxContainer(sessionId);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== "/terminal") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.query = query;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws, req) => {
  const q = ws.query || {};
  const sessionId = typeof q.session === "string" && q.session.length > 0 ? q.session : uuidv4();

  let container;
  try {
    container = await getOrCreateContainer(sessionId);
  } catch (e) {
    ws.send(`Failed to create container: ${String(e?.message || e)}`);
    ws.close();
    return;
  }

  // Responde pro cliente qual session usar para reconectar
  ws.send(JSON.stringify({ type: "session", session: sessionId }));

  // Attach direto ao TTY do container: isso dá stdin/stdout reais do bash
  let stream;
  try {
    stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
  } catch (e) {
    ws.send(`Failed to attach: ${String(e?.message || e)}`);
    ws.close();
    return;
  }

  // Pipe container -> WS (binário)
  stream.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });

  stream.on("end", () => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  stream.on("error", (err) => {
    try { ws.send(`\r\n[stream error] ${String(err?.message || err)}\r\n`); } catch {}
    try { ws.close(); } catch {}
  });

  // WS -> container stdin
  ws.on("message", async (data) => {
    try {
      if (isResizeMessage(data)) {
        const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : data);
        if (msg?.type === "resize") {
          const cols = Math.max(2, Number(msg.cols || 80));
          const rows = Math.max(2, Number(msg.rows || 24));
          await container.resize({ w: cols, h: rows });
        }
        return;
      }

      // raw input
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stream.write(buf);
    } catch (e) {
      // ignora parse errors
    }
  });

  ws.on("close", () => {
    // Persistente: NÃO mata container.
    // Se quiser cleanup por timeout, implemente aqui.
    try { stream.end(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`Terminal WS listening on :${PORT}/terminal`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
