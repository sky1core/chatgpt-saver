// content-script.js
/**
 * chatgpt.com 도메인에 주입되어,
 * 1) URL에서 conversation_id 추출
 * 2) 세션 토큰 가져오기 -> API로 대화내용 (JSON) 받아오기
 * 3) JSON -> Markdown 변환
 * 4) 백그라운드에 blobUrl, fileName 보내 다운로드
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REQUEST_EXPORT") {
        console.log("content-script: REQUEST_EXPORT 메시지 수신 -> 대화 저장 시도 시작...");

        exportConversationAsMarkdown()
            .then(() => {
                sendResponse({ success: true, msg: "Markdown 저장 완료" });
            })
            .catch((err) => {
                sendResponse({ success: false, msg: err.message });
            });

        // 비동기 응답
        return true;
    }
});

function sanitizeFileName(name) {
    // 간단 예시: /나 ? 같은 특수문자를 _ 등으로 대체
    return name.replace(/[\\/:*?"<>|]/g, "_");
}

async function exportConversationAsMarkdown() {
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
        const mdContent = convertJsonToMarkdown(conversationData);
        logDebug(`Markdown 변환 결과 길이: ${mdContent.length}`);

        // (E) Blob URL 생성 후, 백그라운드에 다운로드 요청
        let safeTitle = null;
        if (conversationData.title && conversationData.title.trim().length > 0) {
            // 파일명에 문제될 수 있는 문자 치환
            safeTitle = sanitizeFileName(conversationData.title.trim());
            // 너무 긴 제목 방지(선택 사항)
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

/* ---------- (A) URL에서 conversationId 추출 ---------- */
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

/* ---------- (B) 세션 토큰 가져오기 ---------- */
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

/* ---------- (C) 대화 데이터 fetch ---------- */
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

/* ---------- (D) JSON -> Markdown ---------- */
function convertJsonToMarkdown(conversationData) {
    // 질문에서 보여준 response data를 가정해 mapping 순회
    const { mapping, title } = conversationData;
    if (!mapping) {
        throw new Error("대화 데이터에 mapping이 없습니다 (response 구조 확인).");
    }
    let mdLines = [];

    function traverse(nodeId) {
        const node = mapping[nodeId];
        if (!node) return;

        const msg = node.message;
        if (msg) {
            const role = msg.author?.role || "unknown";
            const parts = msg.content?.parts || [];

            // parts 모두가 빈 문자열인지 확인
            const joinedParts = parts.join("").trim();
            if (joinedParts.length > 0) {
                // 의미 있는 텍스트가 있다면, role 표시 + 텍스트 추가
                if (role === "user") {
                    mdLines.push("**User:**");
                } else if (role === "assistant") {
                    mdLines.push("**ChatGPT:**");
                } else {
                    mdLines.push(`**${role}**:`);
                }

                // 메시지 본문 추가
                parts.forEach((p) => {
                    // 혹시 p가 공백만 있으면 .trim()으로 제거 가능
                    if (p.trim().length > 0) {
                        mdLines.push(p);
                    }
                });

                mdLines.push("\n---\n");
            }
        }

        if (node.children) {
            node.children.forEach(childId => traverse(childId));
        }
    }

    let rootId = findRootId(mapping);
    if (!rootId) {
        // fallback: 첫 키
        rootId = Object.keys(mapping)[0];
    }
    traverse(rootId);

    return mdLines.join("\n");
}

function findRootId(mapping) {
    for (const key in mapping) {
        if (!mapping[key].parent) {
            return key;
        }
    }
    return null;
}

/* ---------- (E) Blob URL -> 백그라운드에 다운로드 요청 ---------- */
function downloadViaBackground(mdContent, fileName) {
    const blob = new Blob([mdContent], { type: "text/markdown" });
    const blobUrl = URL.createObjectURL(blob);

    // background.js로 메시지 전송
    chrome.runtime.sendMessage(
        {
            type: "REQUEST_DOWNLOAD",
            data: { blobUrl, fileName }
        },
        (res) => {
            if (!res || !res.ok) {
                logError("백그라운드 다운로드 실패", res?.error || "");
            } else {
                logDebug(`백그라운드 다운로드 시작 (ID: ${res.downloadId || "?"})`);
            }
        }
    );
}

/* ---------- 디버깅 로깅 함수들 ---------- */
function logDebug(...args) {
    console.log("[content-script DEBUG]", ...args);
    chrome.runtime.sendMessage({ type: "LOG", payload: args.join(" ") });
}
function logError(...args) {
    console.error("[content-script ERROR]", ...args);
    chrome.runtime.sendMessage({ type: "ERROR", payload: args.join(" ") });
}
