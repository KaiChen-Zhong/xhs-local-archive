"use strict";

const baseUrlEl = document.getElementById("baseUrl");
const modelEl = document.getElementById("model");
const apiKeyEl = document.getElementById("apiKey");
const resultEl = document.getElementById("result");

loadSettings();

document.getElementById("save").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: {
        baseUrl: baseUrlEl.value.trim(),
        model: modelEl.value.trim(),
        apiKey: apiKeyEl.value.trim()
      }
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
});

document.getElementById("ping").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "pingHost" }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
});

document.getElementById("testAi").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: {
        baseUrl: baseUrlEl.value.trim(),
        model: modelEl.value.trim(),
        apiKey: apiKeyEl.value.trim()
      }
    }
  }).catch(() => null);
  const result = await chrome.runtime.sendMessage({ type: "testAiProvider" }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
});

document.getElementById("clearAiKey").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: {
        baseUrl: baseUrlEl.value.trim(),
        model: modelEl.value.trim()
      }
    },
    clearAiKey: true
  }).catch((error) => ({ ok: false, error: error.message }));
  apiKeyEl.value = "";
  resultEl.textContent = JSON.stringify(result, null, 2);
  await loadSettings();
});

async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ type: "getSettings" }).catch(() => null);
  const ai = result && result.ok && result.settings && result.settings.ai || {};
  baseUrlEl.value = ai.baseUrl || "";
  modelEl.value = ai.model || "";
  apiKeyEl.value = "";
  apiKeyEl.placeholder = ai.apiKeyConfigured ? "已安全配置；留空保持不变" : "sk-...";
}
