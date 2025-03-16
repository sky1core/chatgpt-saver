// background.js (Manifest V3 service worker)
// 아래 로직을 추가: content script에서 메시지로 넘긴 blobUrl, fileName을 이용하여 다운로드

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        console.log("ChatGPT Markdown Exporter가 새로 설치되었습니다.");
    } else if (details.reason === "update") {
        console.log("ChatGPT Markdown Exporter가 업데이트되었습니다.");
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 기존 LOG/ERROR 처리
    if (message.type === "LOG") {
        console.log("[ContentScript LOG]:", message.payload);
        sendResponse && sendResponse({ ok: true });
        return;
    } else if (message.type === "ERROR") {
        console.error("[ContentScript ERROR]:", message.payload);
        sendResponse && sendResponse({ ok: true });
        return;
    }

    // 새로 추가: REQUEST_DOWNLOAD 처리
    if (message.type === "REQUEST_DOWNLOAD") {
        const { blobUrl, fileName } = message.data || {};
        if (!blobUrl || !fileName) {
            console.error("REQUEST_DOWNLOAD: 파라미터 부족");
            sendResponse && sendResponse({ ok: false, error: "blobUrl/fileName 누락" });
            return;
        }

        chrome.downloads.download(
            {
                url: blobUrl,
                filename: fileName,
                saveAs: false
            },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error("다운로드 오류:", chrome.runtime.lastError.message);
                    sendResponse && sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                    console.log(`다운로드 시작 (ID: ${downloadId})`);
                    sendResponse && sendResponse({ ok: true, downloadId });
                }
            }
        );

        // 비동기 응답
        return true;
    }
});
