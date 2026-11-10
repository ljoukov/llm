import { validateBridgeUrl } from "./protocol.js";

const status = document.querySelector("#status");
const input = document.querySelector("#bridge-url");

function show(value) {
  status.textContent = value.error ?? value.message;
  status.dataset.error = String(Boolean(value.error));
}

async function refresh() {
  try {
    show(await chrome.runtime.sendMessage({ type: "status" }));
  } catch {
    show({ error: "The browser bridge service is unavailable. Reload the extension." });
  }
}

document.querySelector("#connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = validateBridgeUrl(input.value);
    show(await chrome.runtime.sendMessage({ type: "connect", url }));
    input.value = "";
  } catch (error) {
    show({ error: error instanceof Error ? error.message : String(error) });
  }
});

document.querySelector("#disconnect").addEventListener("click", async () => {
  try {
    show(await chrome.runtime.sendMessage({ type: "disconnect" }));
  } catch {
    show({ error: "Could not reach the browser bridge service." });
  }
});

await refresh();
setInterval(() => void refresh(), 1_000);
