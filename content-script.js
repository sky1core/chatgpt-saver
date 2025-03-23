/*************************************
 * content-script.js
 *
 * 기존 대화 메시지도 저장 + 캔버스(코드 블록)도 저장
 *************************************/

// 전역 변수
let pendingCanvasUpdate = null;
// 여러 canvas를 키(textdoc_id)로 구분하여 관리
let canvasTexts = {};

function formatLocalDateTime(tsSec) {
    if (typeof tsSec !== 'number') return '';
    const d = new Date(tsSec * 1000);
    return d.toLocaleString();
}

function getCanvasText(docId) {
    if (!canvasTexts[docId]) {
        canvasTexts[docId] = "";
    }
    return canvasTexts[docId];
}

function setCanvasText(docId, newText) {
    canvasTexts[docId] = newText;
}

// 메시지를 저장할 때, 코드 블록이 아니면 단순히 msg.content.parts.join("\n")를 넣도록
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REQUEST_EXPORT") {
        console.log("content-script: REQUEST_EXPORT 메시지 수신 -> 대화 저장 시도 시작...");

        const showTimestamp = message.data?.showTimestamp || false;
        const allRoles = message.data?.allRoles || false;
        const showImagePrompt = message.data?.showImagePrompt || false;

        exportConversationAsMarkdown({ showTimestamp, allRoles, showImagePrompt })
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
    const { showTimestamp = false, allRoles = false, showImagePrompt = false } = options;
    console.log('[exportConversationAsMarkdown] Received options:', options);

    // Helper function to format timestamp as YYYYMMDDhhmmss
    function formatDateTimeForFilename(timestampSec) {
        const dt = new Date(timestampSec * 1000);
        const year = dt.getFullYear();
        const month = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        const hours = String(dt.getHours()).padStart(2, '0');
        const minutes = String(dt.getMinutes()).padStart(2, '0');
        const seconds = String(dt.getSeconds()).padStart(2, '0');
        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    }

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

        // (B1) Compute prefix from create_time
        let createdTimestamp = conversationData.create_time || Math.floor(Date.now()/1000);
        const datePart = formatDateTimeForFilename(createdTimestamp);
        const globalPrefix = `chatgpt_${datePart}_`;

        // (D) JSON -> Markdown 변환
        const { markdown, images } = await convertJsonToMarkdown(conversationData, {
            conversationId,
            token,
            showTimestamp,
            allRoles,
            showImagePrompt,
            globalPrefix
        });
        logDebug(`Markdown 변환 결과 길이: ${markdown.length}`);

        let safeTitle = null;
        if (conversationData.title && conversationData.title.trim().length > 0) {
            safeTitle = sanitizeFileName(conversationData.title.trim());
            if (safeTitle.length > 60) {
                safeTitle = safeTitle.slice(0, 60) + "...";
            }
        }

        let mdFilename;
        if (safeTitle) {
            mdFilename = `${globalPrefix}${safeTitle}.md`;
        } else {
            mdFilename = `${globalPrefix}conversation_${conversationId}.md`;
        }

        // Gather files to download in one pass
        const filesToDownload = [];

        // (A) Markdown as a Blob
        const mdBlob = new Blob([markdown], { type: "text/markdown" });
        filesToDownload.push({ blob: mdBlob, filename: mdFilename });

        // (B) Images
        for (const img of images) {
            filesToDownload.push({ blob: img.blob, filename: img.filename });
        }

        // (C) Download them all in a single pass using async/await and Blob.arrayBuffer()
        for (const file of filesToDownload) {
            try {
                const arrayBuffer = await file.blob.arrayBuffer();
                const base64Data = arrayBufferToBase64(arrayBuffer);
                const dataUrl = `data:${file.blob.type};base64,${base64Data}`;

                chrome.runtime.sendMessage(
                    {
                        type: "REQUEST_DOWNLOAD",
                        data: {
                            dataUrl,
                            fileName: file.filename
                        }
                    },
                    (res) => {
                        if (!res || !res.ok) {
                            console.error("다운로드 실패:", res?.error || "");
                        } else {
                            console.log(`다운로드 시작 (ID: ${res.downloadId || "?"})`);
                        }
                    }
                );
            } catch (err) {
                console.error("다운로드 오류:", err);
            }
        }


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
        // 빈 문자열 제거 후 마지막 요소 반환
        const pathParts = url.pathname.split("/").filter(Boolean);
        return pathParts[pathParts.length - 1] || null;
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
async function convertJsonToMarkdown(conversationData, opts = {}) {
    const { title, create_time, update_time, mapping } = conversationData;
    if (!mapping) {
        throw new Error("대화 데이터에 mapping이 없습니다.");
    }

    const {
        showTimestamp = false,
        allRoles = false,
        showImagePrompt = false,
        globalPrefix = ''
    } = opts;
    let lines = [];
    const imagesToSave = [];
    let imageCounter = 1;

    // (1) 문서 제목/시간
    const docTitle = title ? title.trim() : "제목 없음";
    lines.push(`# ${docTitle}`);

    let createdStr = formatLocalDateTime(create_time);

    let updatedStr = formatLocalDateTime(update_time);

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
    function addMessageLine(role, timeString, text) {

        let roleLabel;
        if (role === "user") {
            roleLabel = "USER";
        } else if (role === "assistant") {
            roleLabel = "ASSISTANT";
        } else {
            roleLabel = `(${role})`.toUpperCase();
        }

        lines.push(`### ${roleLabel}`);
        if (showTimestamp && timeString) {
            lines.push(`(${timeString})\n`);
        }

        if (role === "user") {
            // user → 코드 블록
            lines.push("```");
            text.split("\n").forEach((line) => lines.push(line));
            lines.push("```");
        } else {
            // assistant, tool, system 등 → 동일 텍스트 처리
            text.split("\n").forEach((line) => lines.push(line));
        }

        lines.push("\n---\n");
    }

    // (3) 트리 구조 순회
    async function traverse(nodeId) {
        const node = mapping[nodeId];
        if (!node) return;

        const msg = node.message;
        if (msg) {
            const role = msg.author?.role || "unknown";
            const contentType = msg.content?.content_type;

            let messageText = "";

            if (role === "assistant" && contentType === "code" && typeof msg.content.text === "string") {
                // Assistant 메시지: 새 캔버스 텍스트(JSON)를 pending 상태로 저장하고, 바로 출력하지 않음
                try {
                    const codeObj = JSON.parse(msg.content.text);
                    pendingCanvasUpdate = codeObj;
                    messageText = ""; // pending 상태이므로 빈 문자열 처리
                } catch (err) {
                    console.error("JSON parse error (assistant):", err);
                    pendingCanvasUpdate = null;
                    messageText = msg.content.text;
                }
            } else if (role === "tool" && msg.metadata?.canvas?.textdoc_id) {
                // Tool 메시지: doc_id가 존재하면, pending 상태의 업데이트를 적용
                const realDocId = msg.metadata.canvas.textdoc_id;
                if (realDocId && pendingCanvasUpdate) {
                    try {
                        if (typeof pendingCanvasUpdate.content === "string") {
                            setCanvasText(realDocId, pendingCanvasUpdate.content);
                        } else if (typeof pendingCanvasUpdate.text === "string") {
                            setCanvasText(realDocId, pendingCanvasUpdate.text);
                        }
                        if (Array.isArray(pendingCanvasUpdate.updates)) {
                            applyUpdatesToCanvasText(realDocId, pendingCanvasUpdate.updates);
                        }
                        // 업데이트된 캔버스 텍스트를 먼저 출력
                        const updatedText = getCanvasText(realDocId);
                        addMessageLine("ASSISTANT", null, updatedText);
                    } catch (e) {
                        console.error("Error applying pending update:", e);
                    }
                    pendingCanvasUpdate = null;
                }
                // doc_id 처리한 메세지는 패스
                messageText = "";
            } else if (contentType === "multimodal_text" && Array.isArray(msg.content?.parts)) {
                let combinedImages = "";
                for (const part of msg.content.parts) {
                    if (part.content_type === "image_asset_pointer" && part.asset_pointer) {
                        try {
                            // (A) parse fileId from asset pointer
                            const pointer = part.asset_pointer; // e.g. "file-service://file-HospME3Lxm69M5F64qDjTK"
                            const fileId = pointer.replace("file-service://", "");

                            // (B) build attachment download API URL
                            const attachmentUrl = `https://chatgpt.com/backend-api/conversation/${opts.conversationId}/attachment/${fileId}/download`;

                            // (C) fetch attachment info to get the real download_url
                            const attachResp = await fetch(attachmentUrl, {
                                method: "GET",
                                headers: {
                                    authorization: `Bearer ${opts.token}`,
                                    accept: "application/json"
                                }
                            });
                            if (!attachResp.ok) {
                                throw new Error(`첨부파일 API 실패: ${attachResp.status} ${attachResp.statusText}`);
                            }
                            const attachJson = await attachResp.json();
                            const signedUrl = attachJson.download_url;
                            if (!signedUrl.includes('sig=')) {
                                console.log("[INFO] No 'sig' parameter in signedUrl, skipping image fetch:", signedUrl);
                                continue;
                            }

                            // (D) 이제 signedUrl로 실제 이미지를 Blob으로 변환
                            console.log("[DEBUG] Attempting to fetch image from URL:", signedUrl);
                            const imageBlob = await fetchImageAsBlob(signedUrl);
                            console.log("[DEBUG] Fetched imageBlob with size:", imageBlob.size);

                            // (E) 파일 이름 생성
                            const originalFilename = attachJson.file_name || `image_${imageCounter}.webp`;
                            const prefixedFilename = `${globalPrefix}${originalFilename.trim()}`;
                            const imageFilename = sanitizeFileName(prefixedFilename);
                            imageCounter++;
                            // Markdown에 이미지 참조
                            combinedImages += `<img src="${imageFilename}" alt="image" style="max-width: 360px;" />\n\n`;
                            if (showImagePrompt && part.metadata && part.metadata.dalle && part.metadata.dalle.prompt) {
                                const promptText = part.metadata.dalle.prompt.trim();
                                combinedImages += `**Prompt**: ${promptText}\n\n`;
                            }
                            // 다운로드 목록에 추가
                            imagesToSave.push({ filename: imageFilename, blob: imageBlob });
                        } catch (error) {
                            console.error("이미지 로드 오류:", error);
                        }
                    }
                }
                if (combinedImages.trim().length > 0) {
                    let timeString = null;
                    if (msg.create_time) {
                        timeString = formatLocalDateTime(msg.create_time);
                    }
                    addMessageLine("ASSISTANT", timeString, combinedImages);
                }
                // 그 외 텍스트 부분도 처리할 경우 이 아래에서 msg.content.parts를 join해서 append 가능.
            } else {
                // 그 외 메시지 처리 (일반 텍스트 등)
                if (typeof msg.content.text === "string") {
                    messageText = msg.content.text;
                } else if (Array.isArray(msg.content?.parts)) {
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
                if (!messageText) {
                    console.log("no message text", msg);
                }

                const joinedText = messageText.trim();
                if (joinedText.length > 0) {
                    let timeString = msg.create_time ? formatLocalDateTime(msg.create_time) : null;
                    addMessageLine(role, timeString, joinedText);
                }
            }
        }

        // 자식 노드 재귀
        if (node.children && node.children.length) {
            for (const childId of node.children) {
                await traverse(childId);
            }
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
    await traverse(rootId);

    return {
        markdown: lines.join("\n"),
        images: imagesToSave
    };
}

/**
 * 실제 canvasText에 부분 치환을 적용 (dotAll + optional global)
 */
function applyUpdatesToCanvasText(docId, updates) {
    let currentText = getCanvasText(docId);
    console.log("[applyUpdatesToCanvasText] initial text:\n", currentText);

    for (const update of updates) {
        const pattern = update.pattern || ".*";
        const flags = update.multiple ? "gs" : "s"; // dotAll + optional global
        const regex = new RegExp(pattern, flags);
        const replacement = update.replacement || "";

        console.log("[applyUpdatesToCanvasText] applying update:", {
            pattern,
            replacement,
            flags,
            oldText: currentText
        });

        currentText = currentText.replace(regex, replacement);
        console.log("[applyUpdatesToCanvasText] after update:\n", currentText);
    }

    setCanvasText(docId, currentText);
    console.log("[applyUpdatesToCanvasText] final text:\n", currentText);
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

async function fetchImageAsBlob(url) {
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
    });
    if (!response.ok) {
        throw new Error(`이미지 다운로드 실패: ${response.status} ${response.statusText}`);
    }
    return await response.blob();
}

function arrayBufferToBase64(arrayBuffer) {
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
