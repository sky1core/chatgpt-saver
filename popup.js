// popup.js

const TIMESTAMP_KEY = "showTimestamp";
const ALLROLES_KEY = "showAllRoles";

document.addEventListener("DOMContentLoaded", () => {
    const chkTimestamp = document.getElementById("chkTimestamp");
    const exportBtn = document.getElementById("exportBtn");
    // 추가
    const chkAllRoles = document.getElementById("chkAllRoles");

    // 초기 로딩 시 storage에서 showTimestamp, showAllRoles 값 가져오기
    chrome.storage.local.get([TIMESTAMP_KEY, ALLROLES_KEY], (result) => {
        const currentTimestamp = !!result[TIMESTAMP_KEY];
        chkTimestamp.checked = currentTimestamp;

        const currentAllRoles = !!result[ALLROLES_KEY];
        chkAllRoles.checked = currentAllRoles;
    });

    // 체크박스 변경 시 저장
    chkTimestamp.addEventListener("change", () => {
        const isChecked = chkTimestamp.checked;
        chrome.storage.local.set({ [TIMESTAMP_KEY]: isChecked }, () => {
            console.log("날짜/시각 표시 설정:", isChecked);
        });
    });

    // (신규) "모든 role 표시" 체크박스 변경 시 저장
    chkAllRoles.addEventListener("change", () => {
        const isChecked = chkAllRoles.checked;
        chrome.storage.local.set({ [ALLROLES_KEY]: isChecked }, () => {
            console.log("모든 role 표시 설정:", isChecked);
        });
    });

    exportBtn.addEventListener("click", () => {
        console.log("popup.js: '대화 저장' 버튼 클릭됨.");

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTabId = tabs[0].id;
            // TIMESTAMP_KEY, ALLROLES_KEY 모두 가져오기
            chrome.storage.local.get([TIMESTAMP_KEY, ALLROLES_KEY], (res) => {
                const showTimestamp = !!res[TIMESTAMP_KEY];
                const allRoles = !!res[ALLROLES_KEY];
                // 두 옵션을 함께 메시지로 넘김
                chrome.tabs.sendMessage(
                    activeTabId,
                    {
                        type: "REQUEST_EXPORT",
                        data: {
                            showTimestamp, // true/false
                            allRoles       // true/false
                        }
                    },
                    (response) => {
                        console.log("popup.js: content-script 응답:", response);
                    }
                );
            });
        });
    });
});