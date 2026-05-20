const FORTUNE_INDEX = "data/mikuji-index.json";
const HISTORY_KEY = "touhouMikujiHistory";
const HISTORY_LIMIT = 10;

const state = {
    fortunes: [],
    currentFortune: null
};

const resultEl = document.getElementById("result");
const drawButton = document.getElementById("draw-button");
const historyToggle = document.getElementById("history-toggle");
const historyPanel = document.getElementById("history-panel");
const historyClose = document.getElementById("history-close");
const historyList = document.getElementById("history-list");
const reviewPanel = document.getElementById("review-panel");
const reviewCard = document.getElementById("review-card");

document.addEventListener("DOMContentLoaded", init);

async function init() {
    drawButton.disabled = true;
    renderHistory();
    drawButton.addEventListener("click", drawMikuji);
    historyToggle.addEventListener("click", toggleHistory);
    historyClose.addEventListener("click", closeHistory);

    try {
        state.fortunes = await loadFortunes();
        drawButton.disabled = false;
    } catch (error) {
        resultEl.innerHTML = '<p class="error-text">签文载入失败。请确认 data/mikuji-index.json 和签文 JSON 可访问。</p>';
        console.error(error);
    }
}

async function loadFortunes() {
    const indexResponse = await fetch(FORTUNE_INDEX);
    if (!indexResponse.ok) {
        throw new Error(`Failed to load ${FORTUNE_INDEX}`);
    }

    const fortuneFiles = await indexResponse.json();
    if (!Array.isArray(fortuneFiles) || fortuneFiles.length === 0) {
        throw new Error(`${FORTUNE_INDEX} must contain at least one fortune path.`);
    }

    const fortunes = await Promise.all(
        fortuneFiles.map(async (path) => {
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
    if (state.fortunes.length === 0) {
        return;
    }

    const index = secureRandomIndex(state.fortunes.length);
    const fortune = state.fortunes[index];

    state.currentFortune = fortune;
    renderFortune(fortune);
    renderReview(fortune);
    saveHistory(fortune);
    renderHistory();
}

function renderFortune(fortune) {
    resultEl.innerHTML = "";

    const resultContent = document.createElement("div");
    resultContent.className = "result-content";
    resultContent.appendChild(createSlip(fortune));
    resultEl.appendChild(resultContent);
}

function renderReview(fortune) {
    const review = fortune.review || {};
    const title = review.title || "评价 / 评论";
    const paragraphs = Array.isArray(review.paragraphs) && review.paragraphs.length > 0
        ? review.paragraphs
        : ["暂无评价。"];

    reviewCard.innerHTML = "";
    reviewPanel.hidden = false;
    const titleEl = createElement("h2", "", title);
    titleEl.id = "review-title";
    reviewCard.appendChild(titleEl);

    paragraphs.forEach((paragraph) => {
        reviewCard.appendChild(createElement("p", "", paragraph));
    });
}

function createSlip(fortune) {
    const slip = document.createElement("article");
    slip.className = "mikuji-slip is-entering";

    const top = document.createElement("header");
    top.className = "slip-top";
    top.append(
        createElement("div", "number-label", fortune.numberLabel || fortune.id || ""),
        createElement("div", "top-separator", ""),
        createRankLabel(fortune)
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
        detail.appendChild(createDetailLayer(layer, fortune));
    });

    slip.append(top, character, oracle, detail);
    return slip;
}

function createDetailLayer(layer, fortune) {
    const items = Array.isArray(layer.items) ? layer.items : [];
    const itemCount = items.length;
    const textLengths = items.map((item) => getDetailItemLength(item));
    const maxChars = textLengths.length > 0 ? Math.max(...textLengths) : 0;
    const totalChars = textLengths.reduce((sum, length) => sum + length, 0);
    const density = getDetailDensity(itemCount, maxChars, totalChars);
    const itemMetrics = items.map((item) => getDetailItemMetrics(item, density));
    const rows = splitDetailRows(items, itemMetrics);

    if (itemCount > 6 || maxChars > 28) {
        console.warn("Dense detail layer detected", fortune.pageTitle || fortune.characterName || fortune.id || "", itemCount, maxChars);
    }

    const layerEl = document.createElement("div");
    layerEl.className = `detail-layer detail-layer--${density}`;
    layerEl.style.setProperty("--detail-item-count", itemCount);
    layerEl.style.setProperty("--detail-max-chars", maxChars);
    layerEl.style.setProperty("--detail-total-chars", totalChars);

    rows.forEach((rowItems) => {
        const rowEl = document.createElement("div");
        rowEl.className = "detail-layer-row";
        const rowMaxChars = rowItems.reduce((max, entry) => Math.max(max, entry.metrics.length), 0);
        const rowTotalLines = rowItems.reduce((sum, entry) => sum + entry.metrics.lines, 0);
        rowEl.style.setProperty("--row-item-count", rowItems.length);
        rowEl.style.setProperty("--row-max-chars", rowMaxChars);
        rowEl.style.setProperty("--row-total-lines", rowTotalLines);
        rowEl.style.setProperty("--detail-row-height", `${getDetailRowHeight(rowMaxChars, density)}px`);

        rowItems.forEach(({ item, metrics }) => {
            const itemEl = document.createElement("div");
            itemEl.className = "detail-item";
            itemEl.style.setProperty("--detail-item-lines", metrics.lines);
            itemEl.style.setProperty("--detail-item-chars", metrics.length);
            itemEl.append(
                createElement("span", "detail-label", item.label || ""),
                createElement("span", "detail-text", item.text || "")
            );
            rowEl.appendChild(itemEl);
        });

        layerEl.appendChild(rowEl);
    });

    return layerEl;
}

function getDetailItemLength(item) {
    return `${item?.label || ""}${item?.text || ""}`.replace(/\s+/g, "").length;
}

function getDetailContentLength(item) {
    return `${item?.label || ""}${item?.text || ""}`
        .replace(/\s+/g, "")
        .replace(/[，。！？：；、,.!?:;（）()「」『』《》—…·・]/g, "")
        .length;
}

function getDetailItemMetrics(item, density) {
    const length = getDetailItemLength(item);
    const contentLength = getDetailContentLength(item);
    const charsPerVerticalLine = density === "dense" ? 13 : density === "compact" ? 14 : 16;
    return {
        item,
        length,
        contentLength,
        lines: Math.max(1, Math.ceil(Math.max(contentLength, 1) / charsPerVerticalLine))
    };
}

function getDetailDensity(itemCount, maxChars, totalChars) {
    if (itemCount > 8 || maxChars > 34 || totalChars > 140) {
        return "dense";
    }

    if (itemCount <= 5 && maxChars <= 22) {
        return "normal";
    }

    return "compact";
}

function splitDetailRows(items, itemMetrics) {
    const entries = items.map((item, index) => ({ item, metrics: itemMetrics[index] }));
    if (entries.length <= 1) {
        return [entries];
    }

    const maxLinesPerRow = 15;
    const totalLines = itemMetrics.reduce((sum, metrics) => sum + metrics.lines, 0);
    if (items.length <= 8 && totalLines <= maxLinesPerRow) {
        return [entries];
    }

    const rows = [];
    let currentRow = [];
    let currentLines = 0;

    entries.forEach((entry) => {
        const wouldExceedWidth = currentRow.length > 0 && currentLines + entry.metrics.lines > maxLinesPerRow;
        const wouldExceedCount = currentRow.length >= 8;
        if (wouldExceedWidth || wouldExceedCount) {
            rows.push(currentRow);
            currentRow = [];
            currentLines = 0;
        }
        currentRow.push(entry);
        currentLines += entry.metrics.lines;
    });

    if (currentRow.length > 0) {
        rows.push(currentRow);
    }

    return rows;
}

function getDetailRowHeight(maxChars, density) {
    if (maxChars > 36) {
        return density === "dense" ? 230 : 210;
    }

    if (maxChars > 26) {
        return density === "dense" ? 205 : 190;
    }

    if (density === "dense") {
        return 185;
    }

    return density === "compact" ? 170 : 154;
}

function createRankLabel(fortune) {
    const rankEl = createElement("div", "rank-label", "");
    const parts = getRankDisplayParts(fortune);
    const isBadge = shouldUseRankBadge(fortune);
    const visibleRankLength = getVisibleRankLength(parts, fortune);
    const rankColorClass = getRankColorClass(fortune);
    const rankContent = isBadge
        ? createElement("span", "rank-badge rank-badge--special", "")
        : createElement("span", "normal-rank-display", "");

    if (rankColorClass) {
        rankContent.classList.add(rankColorClass);
    }

    if (isBadge) {
        rankEl.classList.add("rank-label--badge-mode");
    } else if (visibleRankLength >= 6) {
        rankContent.classList.add("normal-rank-display--very-long");
    } else if (visibleRankLength >= 4) {
        rankContent.classList.add("normal-rank-display--long");
    }

    parts.forEach((part) => {
        const partEl = createElement("span", "rank-part", part.text || "");
        if (rankColorClass) {
            partEl.classList.add(rankColorClass);
        }
        if (part.struck) {
            partEl.classList.add("is-struck");
        }
        rankContent.appendChild(partEl);
    });

    rankEl.appendChild(rankContent);

    return rankEl;
}

function getRankDisplayParts(fortune) {
    if (Array.isArray(fortune.rankDisplay) && fortune.rankDisplay.length > 0) {
        return fortune.rankDisplay.map((part) => ({
            text: part?.text || "",
            struck: Boolean(part?.struck)
        }));
    }

    return [{ text: fortune.rank || "", struck: false }];
}

function getVisibleRankLength(parts, fortune) {
    const visibleRank = parts.map((part) => part.text || "").join("") || fortune.rank || "";
    const openBracket = String.fromCharCode(0x3010);
    const closeBracket = String.fromCharCode(0x3011);
    return visibleRank
        .split(openBracket).join("")
        .split(closeBracket).join("")
        .replace(/[、，。！？：；,.!?:;]/g, "")
        .replace(/\s/g, "")
        .length;
}

function getRankColorClass(fortune) {
    if (fortune.rankColor === "red") {
        return "rank-color-red";
    }

    if (fortune.rankColor === "black") {
        return "rank-color-black";
    }

    return "";
}

function shouldUseRankBadge(fortune) {
    const parts = Array.isArray(fortune.rankDisplay) ? fortune.rankDisplay : [];
    const visibleRank = parts.length > 0
        ? parts.map((part) => part?.text || "").join("")
        : String(fortune.rank || "");
    const openBracket = String.fromCharCode(0x3010);
    const closeBracket = String.fromCharCode(0x3011);

    return visibleRank.includes(openBracket) || visibleRank.includes(closeBracket);
}

function createOracle(fortune) {
    if (Array.isArray(fortune.mainOracleColumns) && fortune.mainOracleColumns.length >= 3 && fortune.mainOracleColumns.length <= 8) {
        const wrapper = document.createElement("div");
        wrapper.className = "main-oracle-columns";
        const columnCount = fortune.mainOracleColumns.length;
        wrapper.style.setProperty("--oracle-column-count", columnCount);
        wrapper.style.setProperty("--oracle-column-gap", columnCount > 5 ? "clamp(0.35rem, 2vw, 0.75rem)" : "clamp(0.55rem, 3vw, 1.1rem)");
        wrapper.style.setProperty("--oracle-column-font-size", columnCount > 5 ? "clamp(0.95rem, 3.2vw, 1.12rem)" : "var(--oracle-size)");

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

function toggleHistory() {
    if (historyPanel.hidden) {
        openHistory();
    } else {
        closeHistory();
    }
}

function openHistory() {
    renderHistory();
    historyPanel.hidden = false;
    historyPanel.classList.add("is-open");
    historyToggle.setAttribute("aria-expanded", "true");
}

function closeHistory() {
    historyPanel.classList.remove("is-open");
    historyPanel.hidden = true;
    historyToggle.setAttribute("aria-expanded", "false");
}

function renderHistory() {
    const history = readHistory();
    historyList.innerHTML = "";

    history.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "history-item";
        const timeLabel = formatHistoryTime(entry.drawnAt);
        item.textContent = `${entry.numberLabel || entry.id} ${entry.rank} ${entry.characterName} ${timeLabel}`;
        historyList.appendChild(item);
    });
}

function formatHistoryTime(value) {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) {
        return "";
    }

    return time.toLocaleString("zh-CN", { hour12: false });
}

function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
}
