#!/usr/bin/env node

import { createHash, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ENDPOINT = "https://thwiki.cc/api.php";
const REFERENCE_URL = "https://thwiki.cc/东方幻存神签";
const CRAWL_DELAY_MS = 60_000;
const JITTER_MIN_MS = 5_000;
const JITTER_MAX_MS = 15_000;
const IMPORT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(IMPORT_ROOT, "cache");
const RAW_DIR = path.join(IMPORT_ROOT, "output", "raw");
const DRAFT_DIR = path.join(IMPORT_ROOT, "output", "draft-json");
const CONFIG_PATH = path.join(IMPORT_ROOT, "import-config.local.json");
const DEFAULT_PROJECT_UA = "TouhouMikujiDataImporter/0.1";

let lastNetworkRequestAt = 0;

main().catch((error) => {
    console.error(error.message);
    if (error.cause?.message) {
        console.error(`Cause: ${error.cause.message}`);
    }
    process.exitCode = 1;
});

async function main() {
    const startedAt = Date.now();
    const args = parseArgs(process.argv.slice(2));
    await ensureOutputDirs();

    if (args["dry-run"]) {
        printDryRun();
        return;
    }

    if (args["confirm-full-import"]) {
        console.log("Full import is not implemented yet.");
        return;
    }

    if (args["pages-file"]) {
        await importPagesFile(args, startedAt);
        return;
    }

    if (!args.page) {
        throw new Error("Provide --dry-run, --confirm-full-import, --pages-file, or --page \"东方幻存神签/角色名\".");
    }

    if (args.limit && Number(args.limit) !== 1) {
        throw new Error("This first importer version supports only --limit 1 for single-page verification.");
    }

    const config = await readLocalConfig();
    const result = await importSinglePage(args.page, args, config);
    console.log(`Wrote draft JSON: ${result.draftPath}`);
    console.log("reviewStatus: draft-needs-manual-review");
}

async function importPagesFile(args, startedAt) {
    const limit = parsePositiveLimit(args.limit, 5);
    if (limit > 20) {
        throw new Error("Stress validation is limited to 20 pages.");
    }

    const config = await readLocalConfig();
    const raw = await readFile(path.resolve(args["pages-file"]), "utf8");
    const pageTitles = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, limit);

    if (!pageTitles.length) {
        throw new Error("No page titles found in --pages-file.");
    }

    const pageResults = [];
    for (const pageTitle of pageTitles) {
        try {
            const result = await importSinglePage(pageTitle, args, config);
            pageResults.push(result.summary);
        } catch (error) {
            pageResults.push({
                pageTitle,
                bilingualPageTitle: args.bilingual ? `${pageTitle}/中日对照` : "",
                success: false,
                draftPath: "",
                cacheUsed: false,
                cacheReads: 0,
                networkRequests: 1,
                missingFields: [],
                parserWarnings: [],
                detailLayersParsedCorrectly: false,
                reviewParagraphsParsedCorrectly: false,
                error: error.message
            });
            await writeImportSummary({ startedAt, limit, pageTitles, pageResults });
            throw error;
        }
    }

    const summary = await writeImportSummary({ startedAt, limit, pageTitles, pageResults });
    console.log(`Wrote import summary: ${relativeToProject(path.join(DRAFT_DIR, "import-summary.json"))}`);
    console.log(`Succeeded: ${summary.totals.succeeded}/${summary.pagesRequested}`);
    console.log(`Network requests: ${summary.totals.networkRequests}`);
    console.log(`Cache reads: ${summary.totals.cacheReads}`);
}

async function writeImportSummary({ startedAt, limit, pageTitles, pageResults }) {
    const summary = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        totalRuntimeMs: Date.now() - startedAt,
        limit,
        pagesRequested: pageTitles.length,
        pages: pageResults,
        totals: {
            succeeded: pageResults.filter((page) => page.success).length,
            failed: pageResults.filter((page) => !page.success).length,
            networkRequests: pageResults.reduce((sum, page) => sum + page.networkRequests, 0),
            cacheReads: pageResults.reduce((sum, page) => sum + page.cacheReads, 0)
        }
    };

    const summaryPath = path.join(DRAFT_DIR, "import-summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
}

async function importSinglePage(pageTitle, args, config) {
    assertAllowedPageTitle(pageTitle);
    const pages = [pageTitle];

    if (args.bilingual) {
        pages.push(`${pageTitle}/中日对照`);
    }

    const responses = [];
    for (const requestedTitle of pages) {
        const params = {
            action: "parse",
            format: "json",
            formatversion: "2",
            page: requestedTitle,
            prop: "wikitext|displaytitle",
            redirects: "1"
        };

        responses.push(await fetchApiJson(params, config, Boolean(args.refresh)));
    }

    let renderedBilingualResponse = null;
    let draft = buildDraft({
        pageTitle,
        bilingualPageTitle: args.bilingual ? `${pageTitle}/中日对照` : "",
        mainResponse: responses[0],
        bilingualResponse: responses[1] || null,
        renderedBilingualResponse,
        debugParse: Boolean(args["debug-parse"])
    });

    if (args.bilingual && needsRenderedTopFields(draft)) {
        const renderedParams = {
            action: "parse",
            format: "json",
            formatversion: "2",
            page: `${pageTitle}/中日对照`,
            prop: "text|displaytitle",
            redirects: "1"
        };
        renderedBilingualResponse = await fetchApiJson(renderedParams, config, Boolean(args.refresh));
        responses.push(renderedBilingualResponse);
        draft = buildDraft({
            pageTitle,
            bilingualPageTitle: `${pageTitle}/中日对照`,
            mainResponse: responses[0],
            bilingualResponse: responses[1] || null,
            renderedBilingualResponse,
            debugParse: Boolean(args["debug-parse"])
        });
    }

    const draftPath = path.join(DRAFT_DIR, `${safeName(pageTitle)}.draft.json`);
    await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    const summary = summarizeDraft(draft, responses, draftPath);
    console.log(`Wrote draft JSON: ${summary.draftPath}`);
    return { draft, draftPath: summary.draftPath, summary };
}

function printDryRun() {
    console.log("THWiki importer dry run: no network requests will be made.");
    console.log("Planned behavior:");
    console.log("- Use MediaWiki Action API at https://thwiki.cc/api.php.");
    console.log("- Allowed actions: action=query and action=parse only.");
    console.log("- Single-page mode fetches the requested page and optional /中日对照 page.");
    console.log("- Full import is not implemented yet.");
    console.log("Robots rule:");
    console.log("- Concurrency: exactly 1.");
    console.log("- Wait at least 60 seconds between real network requests.");
    console.log("- Add 5-15 seconds random jitter after the 60 second delay.");
    console.log("- Cache responses and reuse cache whenever possible.");
    console.log("Output locations:");
    console.log(`- Cache: ${relativeToProject(CACHE_DIR)}`);
    console.log(`- Raw API responses: ${relativeToProject(RAW_DIR)}`);
    console.log(`- Draft JSON: ${relativeToProject(DRAFT_DIR)}`);
    console.log("Legal/source warning:");
    console.log("- Robots.txt access permission is not copyright permission.");
    console.log("- Draft JSON requires manual review before any public website use.");
    console.log("- Do not publish generated draft JSON without review.");
}

function parsePositiveLimit(value, fallback) {
    if (value === undefined) {
        return fallback;
    }

    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer.");
    }

    return limit;
}

function summarizeDraft(draft, responses, draftPath) {
    const missingFields = getMissingFields(draft);
    const cacheReads = responses.filter((response) => response.cacheUsed).length;
    const networkRequests = responses.filter((response) => !response.cacheUsed).length;

    return {
        pageTitle: draft.pageTitle,
        bilingualPageTitle: draft.bilingualPageTitle,
        success: true,
        draftPath: relativeToProject(draftPath),
        cacheUsed: cacheReads > 0,
        cacheReads,
        networkRequests,
        missingFields,
        parserWarnings: draft.parserWarnings,
        detailLayersParsedCorrectly: draft.detailLayers.length >= 2 && draft.detailLayers.every((layer) => Array.isArray(layer.items) && layer.items.length > 0),
        reviewParagraphsParsedCorrectly: Array.isArray(draft.review.paragraphs) && draft.review.paragraphs.length > 0
    };
}

function getMissingFields(draft) {
    const missing = [];
    const requiredTextFields = [
        "id",
        "numberLabel",
        "rank",
        "characterTitle",
        "characterName",
        "abilityText",
        "mainOracleText"
    ];

    for (const field of requiredTextFields) {
        if (!draft[field] || isUnusableDisplayText(draft[field])) {
            missing.push(field);
        }
    }

    if (isInvalidRankDisplay(draft.rankDisplay)) {
        missing.push("rankDisplay");
    }

    if (!Array.isArray(draft.detailLayers) || draft.detailLayers.length < 2) {
        missing.push("detailLayers");
    } else {
        draft.detailLayers.forEach((layer, index) => {
            if (!Array.isArray(layer.items) || layer.items.length === 0) {
                missing.push(`detailLayers[${index}].items`);
            }
        });
    }

    if (!draft.review?.title) {
        missing.push("review.title");
    }

    if (!Array.isArray(draft.review?.paragraphs) || draft.review.paragraphs.length === 0) {
        missing.push("review.paragraphs");
    }

    return missing;
}

function needsRenderedTopFields(draft) {
    return !draft.numberLabel
        || !draft.rank
        || !draft.characterTitle
        || !draft.characterName
        || !draft.abilityText
        || !draft.mainOracleText
        || [
            draft.numberLabel,
            draft.rank,
            draft.characterTitle,
            draft.characterName,
            draft.abilityText,
            draft.mainOracleText
        ].some(isUnusableDisplayText);
}

async function readLocalConfig() {
    if (!existsSync(CONFIG_PATH)) {
        throw new Error("Missing tools/import/import-config.local.json. Add contact information before making requests.");
    }

    const raw = await readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);
    if (!config.contact || typeof config.contact !== "string") {
        throw new Error("tools/import/import-config.local.json must include a contact string.");
    }

    return {
        contact: config.contact,
        userAgentProject: config.userAgentProject || DEFAULT_PROJECT_UA
    };
}

async function fetchApiJson(params, config, refresh) {
    assertAllowedApiAction(params.action);
    assertAllowedPageTitle(params.page || params.title || "");

    const url = buildApiUrl(params);
    assertAllowedRequestUrl(url);

    const cachePath = path.join(CACHE_DIR, `${safeName(params.action)}-${hashParams(params)}.json`);
    const rawPath = path.join(RAW_DIR, `${safeName(params.page || params.title || "api")}-${hashParams(params)}.json`);

    if (!refresh && existsSync(cachePath)) {
        const cached = await readFile(cachePath, "utf8");
        await writeFile(rawPath, cached, "utf8");
        console.log(`Used cache for ${params.page || params.title}: ${relativeToProject(cachePath)}`);
        return {
            data: JSON.parse(cached),
            cacheUsed: true,
            cachePath,
            rawPath,
            params
        };
    }

    await waitForRobotsDelay();

    const response = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "User-Agent": `${config.userAgentProject} (non-commercial fan data organization; contact: ${config.contact})`
        }
    });
    lastNetworkRequestAt = Date.now();

    const body = await response.text();
    assertNetworkResponseAllowed(response, body);

    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error("Malformed API response: expected JSON.");
    }

    assertApiResponseAllowed(parsed);
    await writeFile(cachePath, body, "utf8");
    await writeFile(rawPath, body, "utf8");
    console.log(`Fetched ${params.page || params.title}: ${relativeToProject(rawPath)}`);
    return {
        data: parsed,
        cacheUsed: false,
        cachePath,
        rawPath,
        params
    };
}

function buildDraft({ pageTitle, bilingualPageTitle, mainResponse, bilingualResponse, renderedBilingualResponse, debugParse }) {
    const warnings = [];
    const pageExists = Boolean(mainResponse?.data?.parse?.title || mainResponse?.data?.parse?.pageid);

    if (!pageExists) {
        warnings.push("Main page was not confirmed by parse response; check raw API output.");
    }

    if (bilingualPageTitle && !bilingualResponse?.data?.parse) {
        warnings.push("Bilingual page was requested but not confirmed by parse response.");
    }

    const parsedSource = parseFortuneSource({
        pageTitle,
        mainResponse,
        bilingualResponse,
        renderedBilingualResponse,
        warnings
    });

    const sourceUrl = `https://thwiki.cc/${pageTitle}`;
    const bilingualSourceUrl = bilingualPageTitle ? `https://thwiki.cc/${bilingualPageTitle}` : "";

    const draft = {
        id: parsedSource.id,
        pageTitle,
        bilingualPageTitle,
        sourceUrl,
        bilingualSourceUrl,
        numberLabel: parsedSource.numberLabel,
        rank: parsedSource.rank,
        rankDisplay: parsedSource.rankDisplay,
        characterTitle: parsedSource.characterTitle,
        characterName: parsedSource.characterName || inferCharacterName(pageTitle, warnings),
        abilityText: parsedSource.abilityText,
        mainOracleText: parsedSource.mainOracleText,
        mainOracleColumns: [],
        detailLayers: parsedSource.detailLayers,
        review: {
            title: parsedSource.review.title,
            paragraphs: parsedSource.review.paragraphs
        },
        source: {
            publication: "東方幻存神籤 / 东方幻存神签",
            author: "ZUN",
            referenceSite: "THWiki",
            referenceUrl: sourceUrl,
            dataEntryMethod: "manual-assisted-import",
            rightsNote: "Unofficial non-commercial fan data organization and presentation. Text rights belong to original rights holders. Remove or revise upon valid request."
        },
        reviewStatus: "draft-needs-manual-review",
        parserWarnings: warnings
    };

    if (debugParse) {
        printParseDebug(parsedSource, { mainResponse, bilingualResponse });
    }

    return draft;
}

function inferCharacterName(pageTitle, warnings) {
    const parts = pageTitle.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "东方幻存神签") {
        warnings.push("characterName was inferred from page title and still needs manual review.");
        return parts[1];
    }

    warnings.push("characterName could not be inferred from expected page title shape.");
    return "";
}

const TEMPLATE_EXPANSIONS = new Map([
    ["露米娅称号|1|幻存神签", "使用四周变暗的妖怪"],
    ["露米娅能力|1|幻存神签", "操纵黑暗程度的能力"]
]);

function parseFortuneSource({ pageTitle, mainResponse, bilingualResponse, renderedBilingualResponse, warnings }) {
    const sourceRecord = bilingualResponse?.data?.parse ? bilingualResponse : mainResponse;
    const sourcePageTitle = sourceRecord?.data?.parse?.title || pageTitle;
    const rawContent = getApiContent(sourceRecord?.data);
    const contentFormat = detectContentFormat(rawContent);
    const articleBody = extractArticleBody(rawContent, contentFormat);
    const headings = extractHeadings(articleBody, contentFormat);
    const lines = toContentLines(articleBody, contentFormat);
    const topBlock = getBlockBeforeHeading(lines, "栏目1");
    const topChineseBlocks = getLanguageBlocks(topBlock).filter((block) => isChineseMarker(block.marker));
    const normalizedTopBlocks = topChineseBlocks.map((block) => cleanBlockText(block.lines));

    const renderedTopFields = parseRenderedTopFields(renderedBilingualResponse?.data, pageTitle);
    const numberLabel = chooseDisplayField(compactNumberLabel(normalizedTopBlocks[0] || ""), renderedTopFields.numberLabel);
    const rankInfo = resolveRankDisplay(normalizedTopBlocks[1] || "", renderedTopFields, warnings);
    const rank = rankInfo.rank;
    const rankDisplay = rankInfo.rankDisplay;
    const rawCharacterTitle = normalizedTopBlocks[2] || "";
    const rawAbilityText = normalizedTopBlocks[4] || "";
    const characterTitle = resolveTemplateOrRenderedText(rawCharacterTitle, warnings, "characterTitle", renderedTopFields.characterTitle);
    const characterName = chooseDisplayField(normalizedTopBlocks[3] || "", renderedTopFields.characterName);
    const abilityText = resolveTemplateOrRenderedText(rawAbilityText, warnings, "abilityText", renderedTopFields.abilityText);
    const mainOracleText = chooseDisplayField(normalizeChineseText(normalizedTopBlocks[5] || ""), renderedTopFields.mainOracleText);

    const detailLayers = [
        { items: extractDetailItems(getSectionLines(lines, "栏目1")) },
        { items: extractDetailItems(getSectionLines(lines, "栏目2")) }
    ];
    const review = extractReview(getSectionLines(lines, "评论"));

    addMissingWarnings(warnings, {
        numberLabel,
        rank,
        rankDisplay,
        characterTitle,
        characterName,
        abilityText,
        mainOracleText,
        detailLayers,
        review
    });

    return {
        id: extractIdFromNumber(numberLabel),
        pageTitle: sourcePageTitle,
        sourcePageTitle,
        contentFormat,
        headings,
        numberLabel,
        rank,
        rankDisplay,
        characterTitle,
        characterName,
        abilityText,
        mainOracleText,
        detailLayers,
        review,
        debugLines: {
            top: normalizedTopBlocks,
            layer1: getCandidateLines(getSectionLines(lines, "栏目1")),
            layer2: getCandidateLines(getSectionLines(lines, "栏目2")),
            review: getCandidateLines(getSectionLines(lines, "评论"))
        }
    };
}

function getApiContent(apiResponse) {
    const parse = apiResponse?.parse || {};
    const content = parse.wikitext ?? parse.text ?? "";
    if (typeof content === "string") {
        return content;
    }

    if (content && typeof content === "object" && typeof content["*"] === "string") {
        return content["*"];
    }

    return "";
}

function detectContentFormat(content) {
    const trimmed = String(content || "").trim();
    if (!trimmed) {
        return "unknown";
    }

    if (/<(div|p|table|h[1-6]|span)\b/i.test(trimmed)) {
        return "html";
    }

    if (/^__SETTING__|^==|{{|\[\[|'''/m.test(trimmed)) {
        return "wikitext";
    }

    return "plain text";
}

function extractArticleBody(content, format) {
    if (!content) {
        return "";
    }

    const body = format === "html" ? extractHtmlArticleBody(content) : String(content);
    return stopBeforeNavigationSections(body);
}

function extractHtmlArticleBody(html) {
    const bodyMatch = html.match(/<div[^>]+class="[^"]*mw-parser-output[^"]*"[^>]*>([\s\S]*)$/i);
    return bodyMatch ? bodyMatch[1] : html;
}

function stopBeforeNavigationSections(content) {
    const stopPatterns = [
        /\n==\s*注释\s*==/,
        /\n==\s*词条导航\s*==/,
        /\n{{Bottom}}/i
    ];

    let stopIndex = content.length;
    for (const pattern of stopPatterns) {
        const match = pattern.exec(content);
        if (match && match.index > 0) {
            stopIndex = Math.min(stopIndex, match.index);
        }
    }

    return content.slice(0, stopIndex);
}

function toContentLines(content, format) {
    const text = format === "html" ? stripHtmlTags(content) : stripWikitextMarkup(content);
    return text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter((line) => line.length > 0);
}

function stripWikitextMarkup(text) {
    return String(text)
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/?(big|small|b|i|span)[^>]*>/gi, "")
        .replace(/'''?/g, "")
        .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)]]/g, "$1")
        .replace(/&nbsp;/g, " ");
}

function stripHtmlTags(html) {
    return decodeHtmlEntities(String(html)
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, ""));
}

function decodeHtmlEntities(text) {
    const named = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: "\"",
        apos: "'",
        nbsp: " "
    };

    return String(text)
        .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeWhitespace(text) {
    return decodeHtmlEntities(String(text))
        .replace(/\u3000/g, "")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function normalizeChineseText(text) {
    return normalizeWhitespace(text).replace(/\s+/g, "");
}

function extractHeadings(content, format) {
    if (format === "html") {
        return [...String(content).matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
            .map((match) => normalizeWhitespace(stripHtmlTags(match[1])))
            .filter(Boolean);
    }

    return [...String(content).matchAll(/^={2,6}\s*(.*?)\s*={2,6}$/gm)]
        .map((match) => normalizeWhitespace(match[1]))
        .filter(Boolean);
}

function getBlockBeforeHeading(lines, headingName) {
    const start = lines.findIndex((line) => /^==\s*.+?\s*==$/.test(line));
    const end = lines.findIndex((line) => line === `=== ${headingName} ===`);
    if (start === -1 || end === -1 || end <= start) {
        return [];
    }

    return lines.slice(start + 1, end);
}

function getSectionLines(lines, headingName) {
    const start = lines.findIndex((line) => line === `=== ${headingName} ===`);
    if (start === -1) {
        return [];
    }

    const end = lines.findIndex((line, index) => index > start && /^={2,6}\s*.+?\s*={2,6}$/.test(line));
    return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function getLanguageBlocks(lines) {
    const blocks = [];
    let current = null;

    for (const line of lines) {
        if (/^(ja|jah|zh|zhh|xx)$/.test(line)) {
            if (current) {
                blocks.push(current);
            }
            current = { marker: line, lines: [] };
            continue;
        }

        if (current) {
            current.lines.push(line);
        }
    }

    if (current) {
        blocks.push(current);
    }

    return blocks;
}

function isChineseMarker(marker) {
    return marker === "zh" || marker === "zhh";
}

function cleanBlockText(lines) {
    return normalizeChineseText(lines.join(""));
}

function expandTemplateText(text, warnings, fieldName, renderedFallback = "") {
    const templateMatch = text.match(/^{{(.+)}}$/);
    if (!templateMatch) {
        return text;
    }

    if (renderedFallback) {
        return renderedFallback;
    }

    const key = templateMatch[1].trim();
    if (TEMPLATE_EXPANSIONS.has(key)) {
        return TEMPLATE_EXPANSIONS.get(key);
    }

    warnings.push(`${fieldName} uses unresolved template: ${key}`);
    return "";
}

function resolveTemplateOrRenderedText(text, warnings, fieldName, renderedFallback = "") {
    if (renderedFallback && isUnusableDisplayText(text)) {
        return renderedFallback;
    }

    return expandTemplateText(text, warnings, fieldName, renderedFallback);
}

function chooseDisplayField(text, renderedFallback = "") {
    if (renderedFallback && isUnusableDisplayText(text)) {
        return renderedFallback;
    }

    return text || renderedFallback || "";
}

function isUnusableDisplayText(text) {
    return /{{|}}|<[^>]+>|<\/|style=/.test(String(text || ""));
}

function resolveRankDisplay(rawRank, renderedTopFields, warnings) {
    const renderedRankDisplay = normalizeRankDisplayParts(renderedTopFields.rankDisplay || []);
    if (renderedRankDisplay.length > 0) {
        const effectiveRank = getEffectiveRank(renderedRankDisplay);
        if (!effectiveRank) {
            warnings.push("rankDisplay contains no non-struck effective rank and needs manual review.");
        }

        return {
            rank: effectiveRank || renderedTopFields.rank || "",
            rankDisplay: renderedRankDisplay
        };
    }

    const rank = chooseDisplayField(rawRank, renderedTopFields.rank);
    return {
        rank,
        rankDisplay: rank ? [{ text: rank, struck: false }] : []
    };
}

function normalizeRankDisplayParts(parts) {
    const normalized = [];
    for (const part of parts) {
        const text = normalizeChineseText(part?.text || "");
        if (!text || isUnusableDisplayText(text)) {
            continue;
        }

        const struck = Boolean(part.struck);
        const previous = normalized.at(-1);
        if (previous && previous.struck === struck) {
            previous.text += text;
        } else {
            normalized.push({ text, struck });
        }
    }

    return normalized;
}

function getEffectiveRank(rankDisplay) {
    const finalPlain = [...rankDisplay].reverse().find((part) => part.text && !part.struck);
    return finalPlain?.text || "";
}

function isInvalidRankDisplay(rankDisplay) {
    return !Array.isArray(rankDisplay)
        || rankDisplay.length === 0
        || rankDisplay.some((part) => !part?.text || isUnusableDisplayText(part.text) || typeof part.struck !== "boolean")
        || !getEffectiveRank(rankDisplay);
}

function parseRenderedTopFields(apiResponse, pageTitle) {
    const content = getApiContent(apiResponse);
    const characterNameFromTitle = inferCharacterNameFromTitle(apiResponse?.parse?.title || pageTitle);
    if (!content) {
        return {
            numberLabel: "",
            rank: "",
            rankDisplay: [],
            characterTitle: "",
            characterName: characterNameFromTitle,
            abilityText: "",
            mainOracleText: ""
        };
    }

    const articleBody = extractArticleBody(content, "html");
    const structuredFields = extractRenderedTableTopFields(articleBody, characterNameFromTitle);
    if (
        structuredFields.numberLabel
        || structuredFields.rank
        || structuredFields.characterTitle
        || structuredFields.characterName
        || structuredFields.abilityText
        || structuredFields.mainOracleText
    ) {
        return structuredFields;
    }

    const text = stripHtmlTags(articleBody);
    const lines = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);
    const compactLines = collapseRenderedLines(lines);
    const chineseLines = compactLines.filter((line) => hasChinese(line));
    const characterName = extractRenderedCharacterName(chineseLines);

    return {
        numberLabel: "",
        rank: "",
        rankDisplay: [],
        characterTitle: extractRenderedCharacterTitle(chineseLines, characterName),
        characterName: characterName || characterNameFromTitle,
        abilityText: extractRenderedAbilityText(chineseLines),
        mainOracleText: ""
    };
}

function inferCharacterNameFromTitle(pageTitle) {
    const parts = String(pageTitle || "").split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "东方幻存神签");
    if (index !== -1 && parts[index + 1] && parts[index + 1] !== "中日对照") {
        return parts[index + 1];
    }

    return "";
}

function extractRenderedTableTopFields(html, characterName) {
    if (!characterName) {
        return {
            numberLabel: "",
            rank: "",
            rankDisplay: [],
            characterTitle: "",
            characterName: "",
            abilityText: "",
            mainOracleText: ""
        };
    }

    const rankCell = extractRenderedRankCell(html, characterName);

    return {
        numberLabel: extractRenderedChineseCell(html, characterName, 1, "tt-zhh"),
        rank: rankCell.rank,
        rankDisplay: rankCell.rankDisplay,
        characterTitle: extractRenderedChineseCell(html, characterName, 3, "tt-zhh"),
        characterName: extractRenderedChineseCell(html, characterName, 4, "tt-zhh"),
        abilityText: extractRenderedChineseCell(html, characterName, 5, "tt-zh"),
        mainOracleText: extractRenderedChineseCell(html, characterName, 6, "tt-zhh")
    };
}

function extractRenderedRankCell(html, rowPrefix) {
    const cellHtml = extractRenderedChineseCellHtml(html, rowPrefix, 2, "tt-zhh");
    if (!cellHtml) {
        return { rank: "", rankDisplay: [] };
    }

    const rankDisplay = parseRankDisplayFromHtml(cellHtml);
    return {
        rank: getEffectiveRank(rankDisplay) || normalizeChineseText(stripHtmlTags(cellHtml)),
        rankDisplay
    };
}

function extractRenderedChineseCell(html, rowPrefix, rowNumber, className) {
    const cellHtml = extractRenderedChineseCellHtml(html, rowPrefix, rowNumber, className);
    return cellHtml ? normalizeChineseText(stripHtmlTags(cellHtml)) : "";
}

function extractRenderedChineseCellHtml(html, rowPrefix, rowNumber, className) {
    const escapedRowPrefix = escapeRegex(encodeHtmlAttributeValue(rowPrefix));
    const rowPattern = new RegExp(`<tr\\b[^>]*\\bid="${escapedRowPrefix}-${rowNumber}"[\\s\\S]*?<\\/tr>`, "i");
    const rowMatch = String(html || "").match(rowPattern);
    if (!rowMatch) {
        return "";
    }

    const cellPattern = new RegExp(`<td\\b(?=[^>]*\\bclass="[^"]*\\b${escapeRegex(className)}\\b[^"]*")(?=[^>]*\\blang="zh")[^>]*>([\\s\\S]*?)<\\/td>`, "i");
    const cellMatch = rowMatch[0].match(cellPattern);
    if (!cellMatch) {
        return "";
    }

    return cellMatch[1];
}

function parseRankDisplayFromHtml(html) {
    const source = String(html || "");
    const parts = [];
    const strikePattern = /<(s|del)\b[^>]*>([\s\S]*?)<\/\1>|<([a-z][\w:-]*)\b(?=[^>]*style="[^"]*text-decoration[^"]*(?:line-through|double)[^"]*")[^>]*>([\s\S]*?)<\/\3>/gi;
    let lastIndex = 0;
    let match;

    while ((match = strikePattern.exec(source)) !== null) {
        pushRankDisplayPart(parts, source.slice(lastIndex, match.index), false);
        pushRankDisplayPart(parts, match[2] ?? match[4] ?? "", true);
        lastIndex = strikePattern.lastIndex;
    }

    pushRankDisplayPart(parts, source.slice(lastIndex), false);

    if (parts.length === 0) {
        pushRankDisplayPart(parts, source, false);
    }

    return normalizeRankDisplayParts(parts);
}

function pushRankDisplayPart(parts, rawText, struck) {
    const text = normalizeChineseText(stripHtmlTags(rawText));
    if (text) {
        parts.push({ text, struck });
    }
}

function encodeHtmlAttributeValue(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseRenderedLines(lines) {
    const collapsed = [];
    for (const line of lines) {
        if (/^(ja|jah|zh|zhh|xx)$/.test(line)) {
            continue;
        }

        if (/^\d+$/.test(line) && collapsed.at(-1) === "第") {
            collapsed[collapsed.length - 1] = `第${line}`;
            continue;
        }

        if (line === "号" && /^第\d+$/.test(collapsed.at(-1) || "")) {
            collapsed[collapsed.length - 1] = `${collapsed.at(-1)}号`;
            continue;
        }

        collapsed.push(line);
    }

    return collapsed;
}

function extractRenderedCharacterName(lines) {
    const titleIndex = lines.findIndex((line) => /^第\d+号$/.test(line));
    const rankIndex = lines.findIndex((line, index) => index > titleIndex && isLikelyRank(line));
    if (rankIndex === -1) {
        return "";
    }

    const candidates = lines.slice(rankIndex + 1, rankIndex + 5);
    return candidates.find((line) => isLikelyCharacterName(line)) || "";
}

function extractRenderedCharacterTitle(lines, characterName) {
    const numberIndex = lines.findIndex((line) => /^第\d+号$/.test(line));
    const rankIndex = lines.findIndex((line, index) => index > numberIndex && isLikelyRank(line));
    const nameIndex = characterName ? lines.findIndex((line) => line === characterName) : -1;
    if (rankIndex === -1 || nameIndex === -1 || nameIndex <= rankIndex) {
        return "";
    }

    return lines.slice(rankIndex + 1, nameIndex).find((line) => isLikelyTitle(line)) || "";
}

function extractRenderedAbilityText(lines) {
    return lines.find((line) => /能力$/.test(line) && !line.includes("能力：")) || "";
}

function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(text);
}

function isLikelyRank(text) {
    return /^(?:【?最?凶】?|末吉|小吉|中吉|吉|大吉|超大吉)$/.test(text);
}

function isLikelyCharacterName(text) {
    return /^[\u4e00-\u9fff]{2,8}$/.test(text) && !isLikelyRank(text) && !/能力|使用|号|栏目|评论/.test(text);
}

function isLikelyTitle(text) {
    return hasChinese(text) && text.length <= 32 && !/能力|第\d+号|栏目|评论/.test(text);
}

function compactNumberLabel(text) {
    return normalizeChineseText(text).replace(/^第(\d+)号$/, "第$1号");
}

function extractIdFromNumber(numberLabel) {
    const match = numberLabel.match(/\d+/);
    return match ? match[0] : null;
}

function extractDetailItems(sectionLines) {
    return getLanguageBlocks(sectionLines)
        .filter((block) => isChineseMarker(block.marker))
        .map((block) => {
            const lines = block.lines.map((line) => normalizeWhitespace(line)).filter(Boolean);
            const first = lines[0] || "";
            const match = first.match(/^([^：:]+)[：:](.*)$/);
            if (!match) {
                return null;
            }

            const label = normalizeWhitespace(match[1]);
            const textLines = [match[2], ...lines.slice(1)].map((line) => normalizeWhitespace(line)).filter(Boolean);
            return {
                label,
                text: normalizeChineseText(textLines.join(""))
            };
        })
        .filter(Boolean);
}

function extractReview(sectionLines) {
    const blocks = getLanguageBlocks(sectionLines).filter((block) => isChineseMarker(block.marker));
    const titleBlock = blocks.find((block) => cleanBlockText(block.lines).includes("评论"));
    const title = titleBlock ? normalizeReviewTitle(cleanBlockText(titleBlock.lines)) : "";
    const paragraphs = blocks
        .filter((block) => block !== titleBlock)
        .map((block) => cleanBlockText(block.lines))
        .filter(Boolean);

    return { title, paragraphs };
}

function normalizeReviewTitle(text) {
    return normalizeChineseText(text)
        .replace(/^\[评论]/, "【评论】")
        .replace(/^评论/, "【评论】");
}

function getCandidateLines(sectionLines) {
    return sectionLines
        .filter((line) => !/^(ja|jah|zh|zhh|xx)$/.test(line))
        .slice(0, 12);
}

function addMissingWarnings(warnings, parsed) {
    const requiredTextFields = [
        "numberLabel",
        "rank",
        "characterTitle",
        "characterName",
        "abilityText",
        "mainOracleText"
    ];

    for (const field of requiredTextFields) {
        if (!parsed[field]) {
            warnings.push(`${field} could not be parsed reliably.`);
        } else if (isUnusableDisplayText(parsed[field])) {
            warnings.push(`${field} contains unresolved template or markup and needs manual review.`);
        }
    }

    if (isInvalidRankDisplay(parsed.rankDisplay)) {
        warnings.push("rankDisplay could not be parsed reliably.");
    }

    parsed.detailLayers.forEach((layer, index) => {
        if (!layer.items.length) {
            warnings.push(`detailLayers[${index}].items could not be parsed reliably.`);
        }
    });

    if (!parsed.review.title) {
        warnings.push("review.title could not be parsed reliably.");
    }

    if (!parsed.review.paragraphs.length) {
        warnings.push("review.paragraphs could not be parsed reliably.");
    }
}

function printParseDebug(parsedSource, { mainResponse, bilingualResponse }) {
    console.log("Parse debug:");
    console.log(`- parsed source page: ${parsedSource.sourcePageTitle}`);
    console.log(`- main cache used: ${Boolean(mainResponse?.cacheUsed)}`);
    console.log(`- bilingual cache used: ${Boolean(bilingualResponse?.cacheUsed)}`);
    console.log(`- detected content format: ${parsedSource.contentFormat}`);
    console.log(`- detected section headings: ${parsedSource.headings.join(" | ") || "(none)"}`);
    console.log("- top candidate lines:");
    parsedSource.debugLines.top.slice(0, 8).forEach((line) => console.log(`  ${line}`));
    console.log("- 栏目1 candidate lines:");
    parsedSource.debugLines.layer1.forEach((line) => console.log(`  ${line}`));
    console.log("- 栏目2 candidate lines:");
    parsedSource.debugLines.layer2.forEach((line) => console.log(`  ${line}`));
    console.log("- 评论 candidate lines:");
    parsedSource.debugLines.review.forEach((line) => console.log(`  ${line}`));
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            throw new Error(`Unexpected argument: ${arg}`);
        }

        const key = arg.slice(2);
        if (["dry-run", "bilingual", "refresh", "confirm-full-import", "debug-parse"].includes(key)) {
            args[key] = true;
            continue;
        }

        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
            throw new Error(`Missing value for ${arg}`);
        }
        args[key] = value;
        i += 1;
    }

    return args;
}

async function waitForRobotsDelay() {
    if (!lastNetworkRequestAt) {
        return;
    }

    const elapsed = Date.now() - lastNetworkRequestAt;
    const jitter = randomInt(JITTER_MIN_MS, JITTER_MAX_MS + 1);
    const waitMs = Math.max(0, CRAWL_DELAY_MS - elapsed) + jitter;

    if (waitMs > 0) {
        console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for THWiki crawl-delay plus jitter.`);
        await new Promise((resolve) => {
            setTimeout(resolve, waitMs);
        });
    }
}

function buildApiUrl(params) {
    const url = new URL(API_ENDPOINT);
    const sortedKeys = Object.keys(params).sort();
    for (const key of sortedKeys) {
        url.searchParams.set(key, params[key]);
    }
    return url;
}

function hashParams(params) {
    const sorted = Object.keys(params).sort().map((key) => [key, params[key]]);
    return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function safeName(value) {
    return String(value)
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|#%&{}$!`'@+=]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "thwiki";
}

async function ensureOutputDirs() {
    await mkdir(CACHE_DIR, { recursive: true });
    await mkdir(RAW_DIR, { recursive: true });
    await mkdir(DRAFT_DIR, { recursive: true });
}

function assertAllowedApiAction(action) {
    if (!["query", "parse"].includes(action)) {
        throw new Error(`Disallowed API action: ${action}`);
    }
}

function assertAllowedPageTitle(title) {
    if (!title) {
        return;
    }

    const decoded = decodeURIComponentSafe(title);
    const disallowedPrefixes = ["MediaWiki:", "属性:", "特殊:", "分类:"];
    if (disallowedPrefixes.some((prefix) => decoded.startsWith(prefix))) {
        throw new Error(`Disallowed page title: ${title}`);
    }

    if (decoded.includes("/-/")) {
        throw new Error(`Disallowed page title path: ${title}`);
    }
}

function assertAllowedRequestUrl(url) {
    const decodedUrl = decodeURIComponentSafe(url.toString());
    const decodedPath = decodeURIComponentSafe(url.pathname);
    const decodedQuery = decodeURIComponentSafe(url.search);

    const blockedNeedles = [
        "oldid=",
        "diff=",
        "pagefrom=",
        "pageuntil=",
        "filefrom=",
        "fileuntil=",
        "returnto=",
        "/MediaWiki:",
        "/属性:",
        "/特殊:",
        "title=分类:",
        "title=属性:",
        "title=特殊:"
    ];

    if (decodedPath.includes("/-/") || blockedNeedles.some((needle) => decodedUrl.includes(needle) || decodedQuery.includes(needle))) {
        throw new Error(`Disallowed URL by importer policy: ${url.toString()}`);
    }
}

function assertNetworkResponseAllowed(response, body) {
    if ([403, 429, 503].includes(response.status)) {
        throw new Error(`Stopping immediately after HTTP ${response.status}. Do not retry aggressively.`);
    }

    if (!response.ok) {
        throw new Error(`Network request failed with HTTP ${response.status}.`);
    }

    const trimmed = body.trimStart();
    if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("Unexpected HTML instead of JSON. Stop before retrying.");
    }

    const lower = body.toLowerCase();
    if (lower.includes("captcha") || lower.includes("anti-bot") || lower.includes("cloudflare") || lower.includes("login required")) {
        throw new Error("Captcha, anti-bot challenge, or login requirement detected. Stop immediately.");
    }
}

function assertApiResponseAllowed(parsed) {
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Malformed API response.");
    }

    if (parsed.error) {
        const code = parsed.error.code || "unknown";
        const info = parsed.error.info || "no detail";
        throw new Error(`MediaWiki API error: ${code}: ${info}`);
    }
}

function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function relativeToProject(filePath) {
    return path.relative(path.join(IMPORT_ROOT, "..", ".."), filePath).replace(/\\/g, "/");
}
