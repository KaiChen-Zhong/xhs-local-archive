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
const statusEl = document.getElementById("status");

loadSettings();

document.getElementById("save").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: readFormAiSettings()
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  showResult("保存 AI 设置", result);
  await loadSettings();
});

document.getElementById("ping").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "pingHost" }).catch((error) => ({ ok: false, error: error.message }));
  showResult("检查本地宿主", result);
});

document.getElementById("testAi").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      ai: readFormAiSettings()
    }
  }).catch(() => null);
  const result = await chrome.runtime.sendMessage({ type: "testAiProvider" }).catch((error) => ({ ok: false, error: error.message }));
  showResult("测试 AI", result);
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
  showResult("清除 API Key", result);
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
  renderStatus(result);
}

function fillSlot(role, slot) {
  fields[role].baseUrl.value = slot.baseUrl || "";
  fields[role].model.value = slot.model || "";
  fields[role].apiKey.value = "";
  fields[role].apiKey.placeholder = slot.apiKeyConfigured ? "已安全配置；留空保持不变" : "sk-...";
}

function renderStatus(result) {
  if (!result || !result.ok) {
    statusEl.textContent = `设置状态：读取失败，${result && result.error || "unknown"}`;
    return;
  }
  const ai = result.settings && result.settings.ai || {};
  const text = ai.text || {};
  const vision = ai.vision || {};
  const textReady = Boolean(text.baseUrl && text.model && text.apiKeyConfigured);
  const visionReady = Boolean(vision.baseUrl && vision.model && vision.apiKeyConfigured);
  if (textReady && visionReady) {
    statusEl.textContent = "设置状态：文本 AI 和多模态 AI 已配置。";
  } else if (textReady) {
    statusEl.textContent = "设置状态：文本 AI 已配置，多模态 AI 未完整配置。";
  } else if (visionReady) {
    statusEl.textContent = "设置状态：多模态 AI 已配置，文本 AI 未完整配置。";
  } else {
    statusEl.textContent = "设置状态：AI 未完整配置，批量分类不会调用外部 AI。";
  }
}

function showResult(action, result) {
  const ok = result && result.ok;
  const error = result && (result.error || result.reason);
  if (ok) {
    statusEl.textContent = `${action}：完成。`;
  } else if (error === "ai_settings_incomplete") {
    statusEl.textContent = `${action}：AI 设置不完整，请检查 Base URL、Model、API Key 是否都已填写并保存。`;
  } else {
    statusEl.textContent = `${action}：失败，${error || "unknown"}`;
  }
  resultEl.textContent = JSON.stringify(redactResult(result), null, 2);
}

function redactResult(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/apiKey|authorization|token|secret/i.test(key)) return item ? "[redacted]" : item;
    return item;
  }));
}
