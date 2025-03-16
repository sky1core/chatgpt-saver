/*************************************
 * content-script.js
 *
 * 기존 대화 메시지도 저장 + 캔버스(코드 블록)도 저장
 *************************************/

// 하나의 'canvas' 문서만 있다고 가정, 그 전체 텍스트를 관리하는 전역
let canvasText = "";

// 메시지를 저장할 때, 코드 블록이 아니면 단순히 msg.content.parts.join("\n")를 넣도록
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REQUEST_EXPORT") {
        console.log("content-script: REQUEST_EXPORT 메시지 수신 -> 대화 저장 시도 시작...");

        const showTimestamp = message.data?.showTimestamp || false;
        const allRoles = message.data?.allRoles || false;

        exportConversationAsMarkdown({ showTimestamp, allRoles })
            .then(() => {
                sendResponse({ success: true, msg: "Markdown 저장 완료" });
            })
            .catch((err) => {
                sendResponse({ success: false, msg: err.message });
            });

        return true; // 비동기 응답을 위한 return
    }
});

/**
 * 파일명에서 불가한 문자를 치환
 */
function sanitizeFileName(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 대화(Conversation)를 Markdown으로 변환 후 다운로드
 */
async function exportConversationAsMarkdown(options = {}) {
    const { showTimestamp = false, allRoles = false } = options;

    try {
        logDebug("exportConversationAsMarkdown() 호출됨");

        // (A) URL에서 conversationId 추출
        const conversationId = getConversationIdFromUrl();
        if (!conversationId) {
            throw new Error("URL에서 conversation_id를 찾을 수 없습니다.");
        }
        logDebug("대화 ID:", conversationId);

        // (B) 세션 토큰 가져오기
        const token = await getChatGPTAccessToken();
        logDebug(`가져온 토큰(앞부분): ${token.slice(0, 16)}...`);

        // (C) 백엔드 API 호출 -> JSON 형태 대화 데이터 받기
        const conversationData = await fetchConversationData(conversationId, token);
        logDebug("대화 JSON 일부:", JSON.stringify(conversationData).slice(0, 200));

        // (D) JSON -> Markdown 변환
        const mdContent = convertJsonToMarkdown(conversationData, { showTimestamp, allRoles });
        logDebug(`Markdown 변환 결과 길이: ${mdContent.length}`);

        // (E) Blob URL 생성 -> 백그라운드로 다운로드 요청
        let safeTitle = null;
        if (conversationData.title && conversationData.title.trim().length > 0) {
            safeTitle = sanitizeFileName(conversationData.title.trim());
            if (safeTitle.length > 60) {
                safeTitle = safeTitle.slice(0, 60) + "...";
            }
        }

        const fileName = safeTitle
            ? `chatgpt_${safeTitle}.md`
            : `chatgpt_conversation_${conversationId}.md`;

        downloadViaBackground(mdContent, fileName);

        logDebug("exportConversationAsMarkdown() 완료");
    } catch (err) {
        logError(err.message || String(err));
        throw err;
    }
}

/**
 * URL에서 /c/ 형식으로 conversationId 추출
 */
function getConversationIdFromUrl() {
    try {
        const url = new URL(window.location.href);
        // 예: /c/67d61e3e-4e2c-800a-8b60-e787700aceff
        const pathParts = url.pathname.split("/");
        if (pathParts.length >= 3 && pathParts[1] === "c") {
            return pathParts[2];
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * 세션 토큰 가져오기
 */
async function getChatGPTAccessToken() {
    const resp = await fetch("https://chatgpt.com/api/auth/session", { method: "GET" });
    if (!resp.ok) {
        throw new Error(`세션 정보를 가져오지 못함: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    if (!data || !data.accessToken) {
        throw new Error("로그인 토큰이 없습니다 (로그인 상태 확인 요망).");
    }
    return data.accessToken;
}

/**
 * 대화 데이터 fetch
 */
async function fetchConversationData(conversationId, token) {
    const url = `https://chatgpt.com/backend-api/conversation/${conversationId}`;
    const resp = await fetch(url, {
        method: "GET",
        headers: {
            authorization: `Bearer ${token}`,
            accept: "*/*"
        }
    });
    if (!resp.ok) {
        throw new Error(`대화 API 실패: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
}

/**
 * JSON -> Markdown 변환
 */
function convertJsonToMarkdown(conversationData, opts = {}) {
    const { title, create_time, update_time, mapping } = conversationData;
    if (!mapping) {
        throw new Error("대화 데이터에 mapping이 없습니다.");
    }

    const { showTimestamp = false, allRoles = false } = opts;
    let lines = [];

    // (1) 문서 제목/시간
    const docTitle = title ? title.trim() : "제목 없음";
    lines.push(`# ${docTitle}`);

    let createdStr = "";
    if (typeof create_time === "number") {
        const createdDate = new Date(create_time * 1000);
        createdStr = createdDate.toLocaleString();
    }

    let updatedStr = "";
    if (typeof update_time === "number") {
        const updatedDate = new Date(update_time * 1000);
        updatedStr = updatedDate.toLocaleString();
    }

    const timeTexts = [];
    if (createdStr) {
        timeTexts.push(`생성일시: ${createdStr}`);
    }
    if (updatedStr) {
        timeTexts.push(`수정일시: ${updatedStr}`);
    }

    if (timeTexts.length > 0) {
        lines.push(timeTexts.join(" / "));
        lines.push("");
    }

    // (2) 메시지 표시 함수
    function addMessageLine(roleLabel, timeString, text) {
        lines.push(`### ${roleLabel}`);
        if (showTimestamp && timeString) {
            lines.push(`(${timeString})`);
            lines.push("");
        }

        // USER → 코드 블록
        if (roleLabel === "USER") {
            lines.push("```");
            text.split("\n").forEach((line) => {
                lines.push(line);
            });
            lines.push("```");
        }
        // ASSISTANT → 그냥 텍스트
        else if (roleLabel === "ASSISTANT") {
            text.split("\n").forEach((line) => {
                lines.push(line);
            });
        }
        // 그 외 → 그대로 출력
        else {
            text.split("\n").forEach((line) => {
                lines.push(line);
            });
        }
        lines.push("\n---\n");
    }

    // (3) 트리 구조 순회
    function traverse(nodeId) {
        const node = mapping[nodeId];
        if (!node) return;

        const msg = node.message;
        if (msg) {
            const role = msg.author?.role || "unknown";
            const contentType = msg.content?.content_type;
            let messageText = "";

            // code 타입이면 JSON 파싱 & updates 적용 (캔버스 관련)
            if (contentType === "code" && typeof msg.content.text === "string") {
                let codeObj;
                try {
                    codeObj = JSON.parse(msg.content.text);
                } catch (err) {
                    console.error("[convertJsonToMarkdown] code block JSON 파싱 실패:", err);
                    // 실패 시 원본 그대로
                    messageText = msg.content.text;
                }

                if (codeObj && typeof codeObj === "object") {
                    // codeObj.content or codeObj.text → canvasText에 덮어씀
                    if (typeof codeObj.content === "string" && codeObj.content.trim().length > 0) {
                        canvasText = codeObj.content;
                    } else if (
                        typeof codeObj.text === "string" &&
                        codeObj.text.trim().length > 0
                    ) {
                        canvasText = codeObj.text;
                    }

                    // updates 있으면 치환
                    if (Array.isArray(codeObj.updates)) {
                        applyUpdatesToCanvasText(codeObj.updates);
                    }

                    // 최종 결과
                    messageText = canvasText;
                    console.log("[convertJsonToMarkdown] code block updated text:", messageText);

                    // 인용 블록 변환
                    if (messageText) {
                        const linesQuoted = messageText
                            .split("\n")
                            .map((line) => `> ${line}`)
                            .join("\n");
                        messageText = linesQuoted;
                    }
                } else {
                    // codeObj가 없거나 JSON 아님 → 원본 텍스트 사용
                    messageText = msg.content.text;
                }
            }
            // 일반 텍스트(기존 대화)인 경우
            else {
                // msg.content.parts → joined string
                if (Array.isArray(msg.content?.parts)) {
                    // 여러 줄이면 \n 으로 합침
                    messageText = msg.content.parts.join("\n");
                } else {
                    messageText = "";
                }
            }

            // (4) 메시지 표시 여부
            let canAdd = true;
            if (!allRoles && role !== "user" && role !== "assistant") {
                canAdd = false;
            }

            if (canAdd) {
                let roleLabel = role === "user" || role === "assistant" ? role : `(${role})`;
                roleLabel = roleLabel.toUpperCase();

                const joinedText = messageText.trim();
                if (joinedText.length > 0) {
                    let timeString = null;
                    if (msg.create_time) {
                        const dateObj = new Date(msg.create_time * 1000);
                        timeString = dateObj.toLocaleString();
                    }
                    addMessageLine(roleLabel, timeString, joinedText);
                }
            }
        }

        // 자식 노드 재귀
        if (node.children) {
            node.children.forEach((childId) => traverse(childId));
        }
    }

    // 루트 노드 찾아 순회
    function findRootId(mapping) {
        for (const key in mapping) {
            if (!mapping[key].parent) {
                return key;
            }
        }
        return null;
    }

    let rootId = findRootId(mapping);
    if (!rootId) {
        rootId = Object.keys(mapping)[0];
    }
    traverse(rootId);

    return lines.join("\n");
}

/**
 * 실제 canvasText에 부분 치환을 적용 (dotAll + optional global)
 */
function applyUpdatesToCanvasText(updates) {
    console.log("[applyUpdatesToCanvasText] initial text:\n", canvasText);

    for (const update of updates) {
        const pattern = update.pattern || ".*";
        const flags = update.multiple ? "gs" : "s";  // dotAll + optional global
        const regex = new RegExp(pattern, flags);
        const replacement = update.replacement || "";

        console.log("[applyUpdatesToCanvasText] applying update:", {
            pattern,
            replacement,
            flags,
            oldText: canvasText
        });

        canvasText = canvasText.replace(regex, replacement);
        console.log("[applyUpdatesToCanvasText] after update:\n", canvasText);
    }

    console.log("[applyUpdatesToCanvasText] final text:\n", canvasText);
}

/**
 * Blob URL -> 백그라운드에서 다운로드 처리
 */
function downloadViaBackground(mdContent, fileName) {
    const blob = new Blob([mdContent], { type: "text/markdown" });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage(
        { type: "REQUEST_DOWNLOAD", data: { blobUrl, fileName } },
        (res) => {
            if (!res || !res.ok) {
                logError("백그라운드 다운로드 실패", res?.error || "");
            } else {
                logDebug(`백그라운드 다운로드 시작 (ID: ${res.downloadId || "?"})`);
            }
        }
    );
}

/**
 * 디버깅 로그 함수들
 */
function logDebug(...args) {
    console.log("[content-script DEBUG]", ...args);
    chrome.runtime.sendMessage({ type: "LOG", payload: args.join(" ") });
}
function logError(...args) {
    console.error("[content-script ERROR]", ...args);
    chrome.runtime.sendMessage({ type: "ERROR", payload: args.join(" ") });
}