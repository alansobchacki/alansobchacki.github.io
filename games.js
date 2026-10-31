// Runs my old Ruby terminal games in the browser: Ruby compiled to WebAssembly, rendered with xterm.js.
// Nothing heavy is downloaded until someone actually presses play.

{
  const CDN = "https://cdn.jsdelivr.net/npm";
  const RUBY_WASM = `${CDN}/@ruby/3.4-wasm-wasi@2.10.1/dist/ruby+stdlib.wasm`;

  const games = {
    chess: {
      entry: "main.rb",
      files: ["main.rb", "board.rb", "pawn.rb", "rook.rb", "knight.rb", "bishop.rb", "queen.rb", "king.rb"],
    },
    hangman: { entry: "hangman.rb", files: ["hangman.rb", "10000_words.txt"] },
    "connect-four": { entry: "connect_four.rb", files: ["connect_four.rb"] },
    mastermind: { entry: "mastermind.rb", files: ["mastermind.rb"] },
  };

  // Picks the message matching the language toggle.
  const t = (en, pt) => (document.documentElement.lang === "pt-BR" ? pt : en);

  let libraries = null;
  let rubyModule = null;

  const loadLibraries = () => {
    if (!libraries) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${CDN}/@xterm/xterm@6.0.0/css/xterm.css`;
      document.head.append(css);

      libraries = Promise.all([
        import(`${CDN}/@xterm/xterm@6.0.0/+esm`),
        import(`${CDN}/@xterm/addon-fit@0.11.0/+esm`),
        import(`${CDN}/@bjorn3/browser_wasi_shim@0.4.2/+esm`),
        import(`${CDN}/@ruby/wasm-wasi@2.10.1/+esm`),
      ]).catch((error) => {
        libraries = null;
        throw error;
      });
    }
    return libraries;
  };

  const loadRubyModule = () => {
    rubyModule ??= WebAssembly.compileStreaming(fetch(RUBY_WASM)).catch((error) => {
      rubyModule = null;
      throw error;
    });
    return rubyModule;
  };

  const fetchBytes = async (path) => {
    // Browsers refuse to fetch local files, so the page has to be served over HTTP for the games to load.
    if (location.protocol === "file:") {
      throw new Error(t(
        "The games can't load from file://. Serve the site instead, e.g. `python3 -m http.server`.",
        "Os jogos não carregam via file://. Sirva o site, por exemplo com `python3 -m http.server`.",
      ));
    }
    const response = await fetch(path);
    if (!response.ok) throw new Error(t(`Couldn't load ${path}`, `Não foi possível carregar ${path}`));
    return new Uint8Array(await response.arrayBuffer());
  };

  const runRubyGame = async (slug, terminal, wasiShim, wasmWasi) => {
    const { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } = wasiShim;
    const game = games[slug];

    const [module, prelude, ...gameFiles] = await Promise.all([
      loadRubyModule(),
      fetchBytes("games/prelude.rb"),
      ...game.files.map((file) => fetchBytes(`games/${slug}/${file}`)),
    ]);

    const decoder = new TextDecoder();
    const output = (bytes) => terminal.write(decoder.decode(bytes, { stream: true }));
    const files = new Map(game.files.map((name, index) => [name, new File(gameFiles[index])]));

    const wasi = new WASI([], [], [
      new OpenFile(new File([])),
      new ConsoleStdout(output),
      new ConsoleStdout(output),
      new PreopenDirectory("/", files),
    ], { debug: false });

    const { vm } = await wasmWasi.RubyVM.instantiateModule({ module, wasip1: wasi });

    globalThis.rubyTerminal = terminal;
    await vm.evalAsync(decoder.decode(prelude));
    await vm.evalAsync(`Dir.chdir("/"); load "/${game.entry}"`);
  };

  const dialog = document.getElementById("game-dialog");
  const screen = dialog.querySelector(".game-screen");
  const loading = dialog.querySelector(".game-loading");
  const title = dialog.querySelector(".game-title");

  let currentSlug = null;
  let stopGame = () => {};

  const startGame = async (slug) => {
    stopGame();
    let stopped = false;
    let cleanup = () => {};
    stopGame = () => {
      stopped = true;
      cleanup();
    };

    loading.hidden = false;
    screen.replaceChildren();

    let xterm, fit, wasiShim, wasmWasi;
    try {
      [xterm, fit, wasiShim, wasmWasi] = await loadLibraries();
    } catch (error) {
      loading.hidden = true;
      screen.textContent = `${t("Couldn't load the game", "Não foi possível carregar o jogo")}: ${error.message}`;
      return;
    }
    if (stopped) return;

    const terminal = new xterm.Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 14,
      theme: {
        background: "#020617",
        foreground: "#e2e8f0",
        cursor: "#34d399",
        selectionBackground: "#334155",
      },
    });
    const fitAddon = new fit.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(screen);
    fitAddon.fit();

    // WebAssembly can't block while waiting for input, so the Ruby prelude awaits these promises instead.
    let pending = null;
    let line = "";

    const finishRead = (value) => {
      const read = pending;
      pending = null;
      read?.resolve(value);
    };

    const input = terminal.onData((data) => {
      if (pending?.mode === "key") return finishRead(data);
      if (!pending) return;

      for (const char of data) {
        if (char === "\r") {
          terminal.write("\r\n");
          finishRead(`${line}\n`);
          line = "";
          return;
        }

        if (char === "\x7f") {
          if (line) {
            line = line.slice(0, -1);
            terminal.write("\b \b");
          }
        } else if (char >= " ") {
          line += char;
          terminal.write(char);
        }
      }
    });

    const read = (mode) => new Promise((resolve, reject) => {
      pending = { mode, resolve, reject };
    });

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(screen);

    cleanup = () => {
      resizeObserver.disconnect();
      input.dispose();
      pending?.reject(new Error("Game closed"));
      pending = null;
      terminal.dispose();
    };

    terminal.focus();

    try {
      await runRubyGame(slug, {
        write: (text) => {
          if (stopped) return;
          loading.hidden = true;
          terminal.write(text);
        },
        readLine: () => read("line"),
        readKey: () => read("key"),
        sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
      }, wasiShim, wasmWasi);
    } catch (error) {
      if (stopped) return;
      loading.hidden = true;
      terminal.write(`\r\n\x1b[31m${error instanceof Error ? error.message : error}\x1b[0m\r\n`);
    }
  };

  document.querySelectorAll("[data-game]").forEach((button) => {
    button.addEventListener("click", () => {
      currentSlug = button.dataset.game;
      title.innerHTML = button.querySelector(".game-name").innerHTML;
      dialog.showModal();
      startGame(currentSlug);
    });
  });

  dialog.querySelector(".game-restart").addEventListener("click", () => startGame(currentSlug));
  dialog.querySelector(".game-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => stopGame());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
