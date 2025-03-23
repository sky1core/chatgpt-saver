// popup.js

const TIMESTAMP_KEY = "showTimestamp";
const ALLROLES_KEY = "showAllRoles";
const SHOWIMAGEPROMPT_KEY = "showImagePrompt";

document.addEventListener("DOMContentLoaded", () => {
    const exportBtn = document.getElementById("exportBtn");
    const chkTimestamp = document.getElementById("chkTimestamp");
    const chkAllRoles = document.getElementById("chkAllRoles");
    const chkShowImagePrompt = document.getElementById("chkShowImagePrompt");

    // 초기 로딩 시 storage에서 showTimestamp, showAllRoles, showImagePrompt 값 가져오기
    chrome.storage.local.get([TIMESTAMP_KEY, ALLROLES_KEY, SHOWIMAGEPROMPT_KEY], (result) => {
        const currentTimestamp = !!result[TIMESTAMP_KEY];
        chkTimestamp.checked = currentTimestamp;

        const currentAllRoles = !!result[ALLROLES_KEY];
        chkAllRoles.checked = currentAllRoles;

        const currentShowImagePrompt = !!result[SHOWIMAGEPROMPT_KEY];
        chkShowImagePrompt.checked = currentShowImagePrompt;


    });

    // 체크박스 변경 시 저장
    chkTimestamp.addEventListener("change", () => {
        const isChecked = chkTimestamp.checked;
        chrome.storage.local.set({ [TIMESTAMP_KEY]: isChecked }, () => {
            console.log("날짜/시각 표시 설정:", isChecked);
        });
    });

    // 체크박스 변경 시 저장
    chkAllRoles.addEventListener("change", () => {
        const isChecked = chkAllRoles.checked;
        chrome.storage.local.set({ [ALLROLES_KEY]: isChecked }, () => {
            console.log("모든 role 표시 설정:", isChecked);
        });
    });

    // 체크박스 변경 시 저장
    chkShowImagePrompt.addEventListener("change", () => {
        const isChecked = chkShowImagePrompt.checked;
        chrome.storage.local.set({ [SHOWIMAGEPROMPT_KEY]: isChecked }, () => {
            console.log("이미지 프롬프트 표시 설정:", isChecked);
        });
    });

    exportBtn.addEventListener("click", () => {
        console.log("popup.js: '대화 저장' 버튼 클릭됨.");

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTabId = tabs[0].id;
            // TIMESTAMP_KEY, ALLROLES_KEY, SHOWIMAGEPROMPT_KEY 모두 가져오기
            chrome.storage.local.get([TIMESTAMP_KEY, ALLROLES_KEY, SHOWIMAGEPROMPT_KEY], (res) => {
                const showTimestamp = !!res[TIMESTAMP_KEY];
                const allRoles = !!res[ALLROLES_KEY];
                const showImagePrompt = !!res[SHOWIMAGEPROMPT_KEY];

                // 두 옵션을 함께 메시지로 넘김
                chrome.tabs.sendMessage(
                    activeTabId,
                    {
                        type: "REQUEST_EXPORT",
                        data: {
                            showTimestamp,
                            allRoles,
                            showImagePrompt
                        }
                    },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            alert("페이지를 새로고침한 뒤 다시 시도해주세요.\n오류: " + chrome.runtime.lastError.message);
                            return;
                        }
                        console.log("popup.js: content-script 응답:", response);
                    }
                );
            });
        });
    });
});