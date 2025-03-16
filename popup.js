// popup.js
/**
 * 팝업에서 "대화 저장 (Markdown)" 버튼 클릭 -> content-script.js에 "REQUEST_EXPORT" 메시지 전송
 * content-script.js가 대화 내용을 MD로 변환 후 다운로드
 */

document.addEventListener("DOMContentLoaded", () => {
    const exportBtn = document.getElementById("exportBtn");

    exportBtn.addEventListener("click", () => {
        console.log("popup.js: '대화 저장' 버튼 클릭됨.");

        // 현재 활성 탭 찾기
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTabId = tabs[0].id;
            // content-script.js로 메시지 전송
            chrome.tabs.sendMessage(activeTabId, { type: "REQUEST_EXPORT" }, (response) => {
                console.log("popup.js: content-script 응답:", response);
                if (!response) {
                    console.log("popup.js: 응답이 없거나 오류가 발생함.");
                } else {
                    if (response.success) {
                        console.log("popup.js: 대화 저장 성공:", response.msg);
                    } else {
                        console.error("popup.js: 대화 저장 실패:", response.msg);
                    }
                }
            });
        });
    });
});
