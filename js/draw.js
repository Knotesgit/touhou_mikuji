const FORTUNE_FILES = ["data/mikuji/1.json"];
const HISTORY_KEY = "touhouMikujiHistory";
const HISTORY_LIMIT = 10;

const state = {
    fortunes: [],
    currentFortune: null
};

const resultEl = document.getElementById("result");
const drawButton = document.getElementById("draw-button");
const historyList = document.getElementById("history-list");

document.addEventListener("DOMContentLoaded", init);

async function init() {
    drawButton.disabled = true;

    try {
        state.fortunes = await loadFortunes();
        state.currentFortune = state.fortunes[0];
        renderFortune(state.currentFortune);
        renderHistory();
        drawButton.addEventListener("click", drawMikuji);
        drawButton.disabled = false;
    } catch (error) {
        resultEl.innerHTML = '<p class="error-text">签文载入失败。请确认 data/mikuji/1.json 可访问。</p>';
        console.error(error);
    }
}

async function loadFortunes() {
    const fortunes = await Promise.all(
        FORTUNE_FILES.map(async (path) => {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`Failed to load ${path}`);
            }
            return response.json();
        })
    );

    return fortunes.filter(Boolean);
}

function secureRandomIndex(length) {
    if (!Number.isInteger(length) || length <= 0) {
        throw new Error("Cannot draw from an empty fortune list.");
    }

    const maxUint32 = 0x100000000;
    const limit = Math.floor(maxUint32 / length) * length;
    const buffer = new Uint32Array(1);
    let value;

    do {
        crypto.getRandomValues(buffer);
        value = buffer[0];
    } while (value >= limit);

    return value % length;
}

function drawMikuji() {
    const index = secureRandomIndex(state.fortunes.length);
    const fortune = state.fortunes[index];

    state.currentFortune = fortune;
    renderFortune(fortune);
    saveHistory(fortune);
    renderHistory();
}

function renderFortune(fortune) {
    resultEl.innerHTML = "";

    const resultContent = document.createElement("div");
    resultContent.className = "result-content";
    resultContent.append(createSlip(fortune), createSourceNote(fortune));
    resultEl.appendChild(resultContent);
}

function createSlip(fortune) {
    const slip = document.createElement("article");
    slip.className = "mikuji-slip is-entering";

    const top = document.createElement("header");
    top.className = "slip-top";
    top.append(
        createElement("div", "number-label", fortune.numberLabel || fortune.id || ""),
        createElement("div", "top-separator", ""),
        createElement("div", "rank-label", fortune.rank || "")
    );

    const character = document.createElement("section");
    character.className = "character-area";
    character.append(
        createElement("p", "character-title", fortune.characterTitle || fortune.characterSubtitle || ""),
        createElement("h2", "character-name", fortune.characterName || ""),
        createElement("p", "ability-text", fortune.abilityText || "")
    );

    const oracle = document.createElement("section");
    oracle.className = "oracle-area";
    oracle.appendChild(createOracle(fortune));

    const detail = document.createElement("section");
    detail.className = "detail-layers";
    getDetailLayers(fortune).forEach((layer) => {
        const layerEl = document.createElement("div");
        layerEl.className = "detail-layer";

        (layer.items || []).forEach((item) => {
            const itemEl = document.createElement("div");
            itemEl.className = "detail-item";
            itemEl.append(
                createElement("span", "detail-label", item.label || ""),
                createElement("span", "detail-text", item.text || "")
            );
            layerEl.appendChild(itemEl);
        });

        detail.appendChild(layerEl);
    });

    slip.append(top, character, oracle, detail);
    return slip;
}

function createOracle(fortune) {
    if (Array.isArray(fortune.mainOracleColumns) && fortune.mainOracleColumns.length > 0) {
        const wrapper = document.createElement("div");
        wrapper.className = "oracle-columns";

        fortune.mainOracleColumns.forEach((column) => {
            wrapper.appendChild(createElement("span", "oracle-column", column));
        });

        return wrapper;
    }

    return createElement("div", "oracle-auto", fortune.mainOracleText || "");
}

function getDetailLayers(fortune) {
    if (Array.isArray(fortune.detailLayers)) {
        return fortune.detailLayers;
    }

    if (Array.isArray(fortune.detailSections)) {
        return fortune.detailSections;
    }

    return [];
}

function createSourceNote(fortune) {
    const source = fortune.source || {};
    const note = document.createElement("p");
    note.className = "source-note";

    const publication = source.publication || "来源未填写";
    const author = source.author ? ` / ${source.author}` : "";
    const plainText = `${publication}${author}. ${source.note || ""}`;
    note.textContent = plainText.trim();

    if (source.referenceUrl) {
        note.append(" ");
        const link = document.createElement("a");
        link.href = source.referenceUrl;
        link.textContent = "参考链接";
        link.rel = "noreferrer";
        note.appendChild(link);
    }

    return note;
}

function saveHistory(fortune) {
    const history = readHistory();
    const entry = {
        id: String(fortune.id || ""),
        numberLabel: fortune.numberLabel || "",
        rank: fortune.rank || "",
        characterName: fortune.characterName || "",
        drawnAt: new Date().toISOString()
    };

    history.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

function readHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function renderHistory() {
    const history = readHistory();
    historyList.innerHTML = "";

    history.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "history-item";
        const time = new Date(entry.drawnAt);
        const timeLabel = Number.isNaN(time.getTime()) ? "" : time.toLocaleString();
        item.textContent = `${entry.numberLabel || entry.id} ${entry.rank} ${entry.characterName} ${timeLabel}`;
        historyList.appendChild(item);
    });
}

function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
}
