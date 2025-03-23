// background.js (Manifest V3 service worker)
// content script 쪽에서 blobUrl, fileName을 넘겨주면 다운로드를 처리하는 코드

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        console.log("ChatGPT Saver가 새로 설치되었습니다.");
    } else if (details.reason === "update") {
        console.log("ChatGPT Saver가 업데이트되었습니다.");
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 기존 LOG / ERROR 처리
    if (message.type === "LOG") {
        console.log("[ContentScript LOG]:", message.payload);
        sendResponse && sendResponse({ ok: true });
        return true; // Keep message channel open (Manifest V3)
    } else if (message.type === "ERROR") {
        console.error("[ContentScript ERROR]:", message.payload);
        sendResponse && sendResponse({ ok: true });
        return true;
    }

    // REQUEST_DOWNLOAD 처리
    if (message.type === "REQUEST_DOWNLOAD") {
        const { dataUrl, fileName } = message.data || {};
        if (!dataUrl || !fileName) {
            console.error("REQUEST_DOWNLOAD: 파라미터 부족");
            sendResponse && sendResponse({ ok: false, error: "dataUrl/fileName 누락" });
            return true;
        }

        // dataUrl로 직접 다운로드
        chrome.downloads.download(
            {
                url: dataUrl,
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

        return true; // 비동기 응답
    }
});