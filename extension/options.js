"use strict";

const fields = {
  text: {
    baseUrl: document.getElementById("textBaseUrl"),
    model: document.getElementById("textModel"),
    apiKey: document.getElementById("textApiKey")
  },
  vision: {
    baseUrl: document.getElementById("visionBaseUrl"),
    model: document.getElementById("visionModel"),
    apiKey: document.getElementById("visionApiKey")
  }
};
const resultEl = document.getElementById("result");

loadSettings();

document.getElementById("save").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: readFormAiSettings()
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
  await loadSettings();
});

document.getElementById("ping").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "pingHost" }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
});

document.getElementById("testAi").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: readFormAiSettings()
    }
  }).catch(() => null);
  const result = await chrome.runtime.sendMessage({ type: "testAiProvider" }).catch((error) => ({ ok: false, error: error.message }));
  resultEl.textContent = JSON.stringify(result, null, 2);
  await loadSettings();
});

document.getElementById("clearAiKey").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: {
        text: {
          baseUrl: fields.text.baseUrl.value.trim(),
          model: fields.text.model.value.trim()
        },
        vision: {
          baseUrl: fields.vision.baseUrl.value.trim(),
          model: fields.vision.model.value.trim()
        }
      }
    },
    clearAiKey: true
  }).catch((error) => ({ ok: false, error: error.message }));
  fields.text.apiKey.value = "";
  fields.vision.apiKey.value = "";
  resultEl.textContent = JSON.stringify(result, null, 2);
  await loadSettings();
});

function readFormAiSettings() {
  return {
    text: {
      baseUrl: fields.text.baseUrl.value.trim(),
      model: fields.text.model.value.trim(),
      apiKey: fields.text.apiKey.value.trim()
    },
    vision: {
      baseUrl: fields.vision.baseUrl.value.trim(),
      model: fields.vision.model.value.trim(),
      apiKey: fields.vision.apiKey.value.trim()
    }
  };
}

async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ type: "getSettings" }).catch(() => null);
  const ai = result && result.ok && result.settings && result.settings.ai || {};
  const text = ai.text || { baseUrl: ai.baseUrl || "", model: ai.model || "", apiKeyConfigured: ai.apiKeyConfigured };
  const vision = ai.vision || {};
  fillSlot("text", text);
  fillSlot("vision", vision);
}

function fillSlot(role, slot) {
  fields[role].baseUrl.value = slot.baseUrl || "";
  fields[role].model.value = slot.model || "";
  fields[role].apiKey.value = "";
  fields[role].apiKey.placeholder = slot.apiKeyConfigured ? "已安全配置；留空保持不变" : "sk-...";
}
