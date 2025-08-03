// 스와이프 뷰어 확장 - SillyTavern Extension
// 메시지의 지난 스와이프들을 확인할 수 있는 기능 제공

import {
    eventSource,
    event_types,
    chat,
    addOneMessage,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
    Popup,
} from '../../../popup.js';

import {
    uuidv4,
    timestampToMoment,
    waitUntilCondition,
} from '../../../utils.js';

// 확장 이름 및 상수 정의
const pluginName = 'swipe-viewer';
const MODAL_ID = 'swipeViewerModal';

// LLM Translator DB 상수 (번역 지원용)
const DB_NAME = 'LLMtranslatorDB';
const STORE_NAME = 'translations';

// 메시지 버튼 HTML (스와이프 아이콘)
const messageButtonHtml = `
    <div class="mes_button swipe-viewer-icon interactable" title="스와이프 보기" tabindex="0">
        <i class="fa-solid fa-arrow-right-arrow-left"></i>
    </div>
`;

// 현재 팝업 상태
let currentPopup = null;
let currentMessageIndex = -1;
let currentSwipeIndex = 0;
let currentViewMode = 'both'; // 'both', 'original', 'translation'

/**
 * LLM Translator DB 열기
 */
async function openTranslatorDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        
        request.onerror = () => {
            console.warn('[SwipeViewer] LLM Translator DB를 열 수 없습니다:', request.error);
            resolve(null); // DB가 없어도 계속 진행
        };
        
        request.onsuccess = () => {
            resolve(request.result);
        };
    });
}

/**
 * 원문으로 번역문 가져오기
 */
async function getTranslationFromDB(originalText) {
    try {
        const db = await openTranslatorDB();
        if (!db) return null;
        
        return new Promise((resolve) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('originalText');
            const request = index.get(originalText);
            
            request.onsuccess = (event) => {
                const record = event.target.result;
                resolve(record ? record.translation : null);
            };
            
            request.onerror = () => {
                resolve(null);
            };
            
            transaction.oncomplete = () => {
                db.close();
            };
        });
    } catch (error) {
        console.warn('[SwipeViewer] 번역문 조회 중 오류:', error);
        return null;
    }
}

/**
 * 특정 스와이프의 번역문 가져오기
 */
async function getSwipeTranslation(messageIndex, swipeIndex) {
    try {
        if (messageIndex < 0 || messageIndex >= chat.length) {
            return null;
        }
        
        const message = chat[messageIndex];
        if (!message || !message.swipes || swipeIndex >= message.swipes.length) {
            return null;
        }
        
        const swipeText = message.swipes[swipeIndex];
        if (!swipeText) {
            return null;
        }
        
        // substituteParams를 사용해서 원문 처리 (LLM Translator 방식과 동일)
        const context = getContext();
        const originalText = substituteParams(swipeText, context.name1, message.name);
        
        return await getTranslationFromDB(originalText);
    } catch (error) {
        console.warn('[SwipeViewer] 스와이프 번역문 조회 중 오류:', error);
        return null;
    }
}

/**
 * 메시지에 스와이프 뷰어 아이콘 추가
 */
function addSwipeViewerIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const extraButtonsContainer = messageElement.find('.extraMesButtons');
        
        // extraMesButtons 컨테이너가 있고 이미 버튼이 없으면 추가
        if (extraButtonsContainer.length && !extraButtonsContainer.find('.swipe-viewer-icon').length) {
            extraButtonsContainer.prepend(messageButtonHtml);
        }
    });
}

/**
 * 메시지 인덱스로부터 스와이프 데이터 가져오기
 */
function getSwipeData(messageIndex) {
    if (messageIndex < 0 || messageIndex >= chat.length) {
        return null;
    }
    
    const message = chat[messageIndex];
    if (!message || !message.swipes || message.swipes.length === 0) {
        return null;
    }
    
    return {
        swipes: message.swipes,
        currentSwipeId: message.swipe_id || 0,
        messageIndex: messageIndex,
        isBot: message.is_user === false
    };
}

/**
 * 스와이프 뷰어 팝업 생성
 */
async function createSwipeViewerPopup(messageIndex) {
    const swipeData = getSwipeData(messageIndex);
    if (!swipeData) {
        console.warn('스와이프 데이터가 없습니다.');
        return;
    }
    
    currentMessageIndex = messageIndex;
    currentSwipeIndex = swipeData.currentSwipeId;
    
    // 기존 모달이 있으면 제거
    if (currentPopup) {
        closeSwipeViewerPopup();
    }
    
    // 현재 스와이프의 번역문 확인
    const translation = await getSwipeTranslation(messageIndex, currentSwipeIndex);
    const hasTranslation = translation && translation.trim();
    
    // 백드롭 생성
    const backdrop = $(`
        <div id="${MODAL_ID}" class="swipe-viewer-backdrop">
            <div class="swipe-viewer-modal">
                <div class="swipe-viewer-header">
                    <h3>스와이프 뷰어 (${currentSwipeIndex + 1}/${swipeData.swipes.length})</h3>
                    <button class="swipe-viewer-close" title="닫기">×</button>
                </div>
                <div class="swipe-viewer-body">
                    <div class="swipe-viewer-content">
                        ${createSwipeContentHTML(swipeData.swipes[currentSwipeIndex] || '', translation, hasTranslation)}
                    </div>
                </div>
                <div class="swipe-viewer-navigation">
                    <button class="swipe-nav-btn swipe-prev" title="이전 스와이프" ${currentSwipeIndex === 0 ? 'disabled' : ''}>
                        &lt;
                    </button>
                    <div class="swipe-viewer-controls">
                        <div class="view-mode-dropdown ${hasTranslation ? '' : 'disabled'}" title="표시 모드 선택">
                            <button class="view-mode-btn">
                                <span class="view-mode-text">${getViewModeText(currentViewMode)}</span>
                                <i class="fa-solid fa-chevron-down view-mode-arrow"></i>
                            </button>
                            <div class="view-mode-menu">
                                <div class="view-mode-option ${currentViewMode === 'both' ? 'active' : ''}" data-mode="both">
                                    <i class="fa-solid fa-layer-group"></i>
                                    <span>원문/번역문 보기</span>
                                </div>
                                <div class="view-mode-option ${currentViewMode === 'original' ? 'active' : ''}" data-mode="original">
                                    <i class="fa-solid fa-file-text"></i>
                                    <span>원문만 보기</span>
                                </div>
                                <div class="view-mode-option ${currentViewMode === 'translation' ? 'active' : ''}" data-mode="translation" ${hasTranslation ? '' : 'style="display:none"'}>
                                    <i class="fa-solid fa-language"></i>
                                    <span>번역문만 보기</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button class="swipe-nav-btn swipe-next" title="다음 스와이프" ${currentSwipeIndex >= swipeData.swipes.length - 1 ? 'disabled' : ''}>
                        &gt;
                    </button>
                </div>
            </div>
        </div>
    `);
    
    // DOM에 추가
    $('body').append(backdrop);
    
    // 애니메이션을 위한 클래스 추가
    setTimeout(() => {
        backdrop.addClass('visible');
        backdrop.find('.swipe-viewer-modal').addClass('visible');
    }, 10);
    
    currentPopup = backdrop;
    setupPopupEventHandlers();
}

/**
 * 뷰 모드 텍스트 반환
 */
function getViewModeText(mode) {
    switch (mode) {
        case 'both': return '원문/번역문 보기';
        case 'original': return '원문만 보기';
        case 'translation': return '번역문만 보기';
        default: return '원문/번역문 보기';
    }
}

/**
 * 텍스트 복사하기
 */
async function copyToClipboard(text, button) {
    console.log('[스와이프 뷰어] 복사 함수 호출됨');
    console.log('[스와이프 뷰어] 복사할 텍스트:', text);
    console.log('[스와이프 뷰어] 버튼 요소:', button);
    
    // 텍스트가 비어있는지 확인
    if (!text || typeof text !== 'string') {
        console.error('[스와이프 뷰어] 복사할 텍스트가 유효하지 않음:', text);
        return;
    }
    
    // 버튼이 유효한지 확인
    if (!button) {
        console.error('[스와이프 뷰어] 버튼 요소가 유효하지 않음:', button);
        return;
    }
    
    try {
        console.log('[스와이프 뷰어] navigator.clipboard 사용 시도');
        
        // Clipboard API 지원 여부 확인
        if (!navigator.clipboard) {
            console.warn('[스와이프 뷰어] navigator.clipboard가 지원되지 않음, 폴백 사용');
            throw new Error('Clipboard API not supported');
        }
        
        await navigator.clipboard.writeText(text);
        console.log('[스와이프 뷰어] navigator.clipboard.writeText 성공');
        
        // 복사 완료 피드백
        const originalText = button.innerHTML;
        console.log('[스와이프 뷰어] 버튼 피드백 시작, 원래 텍스트:', originalText);
        
        button.innerHTML = '<i class="fa-solid fa-check"></i>';
        button.style.color = '#4CAF50';
        
        setTimeout(() => {
            button.innerHTML = originalText;
            button.style.color = '';
            console.log('[스와이프 뷰어] 버튼 피드백 완료');
        }, 1500);
        
    } catch (err) {
        console.error('[스와이프 뷰어] Clipboard API 실패:', err);
        console.log('[스와이프 뷰어] 폴백 방식 시도');
        
        try {
            // 폴백: 텍스트 선택
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            
            console.log('[스와이프 뷰어] textarea 생성 및 텍스트 설정 완료');
            
            textArea.select();
            textArea.setSelectionRange(0, 99999); // 모바일 지원
            
            console.log('[스와이프 뷰어] 텍스트 선택 완료');
            
            const successful = document.execCommand('copy');
            console.log('[스와이프 뷰어] execCommand 결과:', successful);
            
            document.body.removeChild(textArea);
            console.log('[스와이프 뷰어] textarea 제거 완료');
            
            if (!successful) {
                throw new Error('execCommand failed');
            }
            
            // 복사 완료 피드백
            const originalText = button.innerHTML;
            console.log('[스와이프 뷰어] 폴백 복사 성공, 버튼 피드백 시작');
            
            button.innerHTML = '<i class="fa-solid fa-check"></i>';
            button.style.color = '#4CAF50';
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.style.color = '';
                console.log('[스와이프 뷰어] 폴백 버튼 피드백 완료');
            }, 1500);
            
        } catch (fallbackErr) {
            console.error('[스와이프 뷰어] 폴백 복사도 실패:', fallbackErr);
            
            // 실패 피드백
            const originalText = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-times"></i>';
            button.style.color = '#f44336';
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.style.color = '';
            }, 1500);
        }
    }
}

/**
 * 스와이프 콘텐츠 HTML 생성 (번역문 유무 및 뷰 모드에 따라 다르게)
 */
function createSwipeContentHTML(originalText, translation, hasTranslation) {
    console.log('[스와이프 뷰어] createSwipeContentHTML 호출됨');
    console.log('[스와이프 뷰어] 원문:', originalText);
    console.log('[스와이프 뷰어] 번역문:', translation);
    console.log('[스와이프 뷰어] 번역문 존재 여부:', hasTranslation);
    
    // HTML 속성 안전처리 (따옴표 이스케이프)
    const escapeForAttr = (text) => {
        if (!text) return '';
        const escaped = text.replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
        console.log('[스와이프 뷰어] 이스케이프 처리 - 원본:', text.substring(0, 50) + '...');
        console.log('[스와이프 뷰어] 이스케이프 처리 - 결과:', escaped.substring(0, 50) + '...');
        return escaped;
    };
    
    // 번역문이 없으면 원문만 표시
    if (!hasTranslation) {
        console.log('[스와이프 뷰어] 단일 뷰 생성 중');
        return `
            <div class="swipe-text-container single-view">
                <div class="swipe-text-header">
                    <button class="copy-btn" data-copy-text="${escapeForAttr(originalText)}" title="텍스트 복사">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
                <textarea readonly class="swipe-text-area single-text">${originalText}</textarea>
            </div>
        `;
    }
    
    // 번역문이 있을 때 뷰 모드에 따라 결정
    switch (currentViewMode) {
        case 'original':
            console.log('[스와이프 뷰어] 원문만 보기 뷰 생성 중');
            return `
                <div class="swipe-text-container single-view">
                    <div class="swipe-text-header">
                        <label class="swipe-text-label">원문</label>
                        <button class="copy-btn" data-copy-text="${escapeForAttr(originalText)}" title="원문 복사">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                    <textarea readonly class="swipe-text-area original-text single-mode">${originalText}</textarea>
                </div>
            `;
        case 'translation':
            if (!translation || !translation.trim()) {
                console.log('[스와이프 뷰어] 번역문 없음 안내 표시');
                return `
                    <div class="swipe-text-container single-view">
                        <div class="no-translation-notice">
                            <i class="fa-solid fa-info-circle"></i>
                            <h4>번역문이 없습니다</h4>
                            <p>이 스와이프에는 번역된 텍스트가 없습니다.<br/>
                            드롭다운에서 다른 보기 모드를 선택해보세요.</p>
                        </div>
                    </div>
                `;
            }
            console.log('[스와이프 뷰어] 번역문만 보기 뷰 생성 중');
            return `
                <div class="swipe-text-container single-view">
                    <div class="swipe-text-header">
                        <label class="swipe-text-label">번역문</label>
                        <button class="copy-btn" data-copy-text="${escapeForAttr(translation)}" title="번역문 복사">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                    <textarea readonly class="swipe-text-area translation-text single-mode">${translation}</textarea>
                </div>
            `;
        case 'both':
        default:
            console.log('[스와이프 뷰어] 이중 뷰 생성 중');
            return `
                <div class="swipe-text-container dual-view">
                    <div class="swipe-text-section">
                        <div class="swipe-text-header">
                            <label class="swipe-text-label">원문</label>
                            <button class="copy-btn" data-copy-text="${escapeForAttr(originalText)}" title="원문 복사">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                        <textarea readonly class="swipe-text-area original-text">${originalText}</textarea>
                    </div>
                    <div class="swipe-text-section">
                        <div class="swipe-text-header">
                            <label class="swipe-text-label">번역문</label>
                            <button class="copy-btn" data-copy-text="${escapeForAttr(translation)}" title="번역문 복사">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                        <textarea readonly class="swipe-text-area translation-text">${translation}</textarea>
                    </div>
                </div>
            `;
    }
}

/**
 * 팝업 이벤트 핸들러 설정
 */
function setupPopupEventHandlers() {
    console.log('[스와이프 뷰어] 팝업 이벤트 핸들러 설정 중');
    const modal = $(`#${MODAL_ID}`);
    
    // 복사 버튼 이벤트 위임
    modal.on('click', '.copy-btn', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const button = $(this)[0];
        const copyText = $(this).attr('data-copy-text');
        
        console.log('[스와이프 뷰어] 복사 버튼 클릭됨');
        console.log('[스와이프 뷰어] data-copy-text:', copyText);
        
        if (copyText) {
            // HTML 엔티티 디코딩
            const decodedText = copyText
                .replace(/&#39;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r');
            
            console.log('[스와이프 뷰어] 디코딩된 텍스트:', decodedText);
            copyToClipboard(decodedText, button);
        } else {
            console.error('[스와이프 뷰어] data-copy-text 속성이 없습니다');
        }
    });
    
    // 백드롭 클릭으로 닫기
    modal.on('click', (e) => {
        if (e.target === modal[0]) {
            closeSwipeViewerPopup();
        }
    });
    
    // 모달 내부 클릭 시 이벤트 전파 방지
    modal.find('.swipe-viewer-modal').on('click', (e) => {
        e.stopPropagation();
    });
    
    // 닫기 버튼
    modal.find('.swipe-viewer-close').on('click', () => {
        closeSwipeViewerPopup();
    });
    
    // 이전 스와이프 버튼
    modal.find('.swipe-prev').on('click', () => {
        navigateSwipe(-1);
    });
    
    // 다음 스와이프 버튼
    modal.find('.swipe-next').on('click', () => {
        navigateSwipe(1);
    });
    
    // 뷰 모드 드롭다운 토글
    modal.find('.view-mode-btn').on('click', (e) => {
        e.stopPropagation();
        const dropdown = modal.find('.view-mode-dropdown');
        dropdown.toggleClass('open');
    });
    
    // 뷰 모드 옵션 선택
    modal.find('.view-mode-option').on('click', async (e) => {
        const option = $(e.currentTarget);
        const newMode = option.data('mode');
        
        if (newMode !== currentViewMode) {
            currentViewMode = newMode;
            await updateSwipeDisplay();
        }
        
        modal.find('.view-mode-dropdown').removeClass('open');
    });
    
    // 드롭다운 외부 클릭 시 닫기
    modal.on('click', (e) => {
        if (!$(e.target).closest('.view-mode-dropdown').length) {
            modal.find('.view-mode-dropdown').removeClass('open');
        }
    });
    
    // 키보드 네비게이션
    $(document).on('keydown.swipeViewer', (e) => {
        if (e.key === 'ArrowLeft') {
            navigateSwipe(-1);
        } else if (e.key === 'ArrowRight') {
            navigateSwipe(1);
        } else if (e.key === 'Escape') {
            closeSwipeViewerPopup();
        }
    });
}

/**
 * 스와이프 네비게이션
 */
function navigateSwipe(direction) {
    const swipeData = getSwipeData(currentMessageIndex);
    if (!swipeData) return;
    
    const newIndex = currentSwipeIndex + direction;
    if (newIndex < 0 || newIndex >= swipeData.swipes.length) return;
    
    currentSwipeIndex = newIndex;
    updateSwipeDisplay();
}

/**
 * 스와이프 디스플레이 업데이트
 */
async function updateSwipeDisplay() {
    const swipeData = getSwipeData(currentMessageIndex);
    if (!swipeData) return;
    
    const modal = $(`#${MODAL_ID}`);
    
    // 헤더 업데이트
    modal.find('.swipe-viewer-header h3').text(`스와이프 뷰어 (${currentSwipeIndex + 1}/${swipeData.swipes.length})`);
    
    // 현재 스와이프의 번역문 확인
    const originalText = swipeData.swipes[currentSwipeIndex] || '';
    const translation = await getSwipeTranslation(currentMessageIndex, currentSwipeIndex);
    const hasTranslation = translation && translation.trim();
    
    // 콘텐츠 영역 전체 교체
    const contentHTML = createSwipeContentHTML(originalText, translation, hasTranslation);
    modal.find('.swipe-viewer-content').html(contentHTML);
    
    // 뷰 모드 드롭다운 상태 업데이트
    const dropdown = modal.find('.view-mode-dropdown');
    dropdown.toggleClass('disabled', !hasTranslation);
    
    // 뷰 모드 텍스트 업데이트
    modal.find('.view-mode-text').text(getViewModeText(currentViewMode));
    
    // 활성 옵션 업데이트
    modal.find('.view-mode-option').removeClass('active');
    modal.find(`.view-mode-option[data-mode="${currentViewMode}"]`).addClass('active');
    
    // 번역문 옵션 표시/숨김
    const translationOption = modal.find('.view-mode-option[data-mode="translation"]');
    if (hasTranslation) {
        translationOption.show();
        translationOption.removeClass('disabled');
    } else {
        translationOption.show(); // 번역문이 없어도 옵션은 보이게 함
        // 번역문이 없을 때는 옵션을 비활성화 상태로 표시
        translationOption.addClass('disabled');
    }
    
    // 네비게이션 버튼 상태 업데이트
    modal.find('.swipe-prev').prop('disabled', currentSwipeIndex === 0);
    modal.find('.swipe-next').prop('disabled', currentSwipeIndex >= swipeData.swipes.length - 1);
}

/**
 * 스와이프 뷰어 팝업 닫기
 */
function closeSwipeViewerPopup() {
    if (currentPopup) {
        // 애니메이션과 함께 닫기
        currentPopup.removeClass('visible');
        currentPopup.find('.swipe-viewer-modal').removeClass('visible');
        
        setTimeout(() => {
            currentPopup.remove();
            currentPopup = null;
        }, 300);
    }
    
    // 키보드 이벤트 핸들러 제거
    $(document).off('keydown.swipeViewer');
    
    currentMessageIndex = -1;
    currentSwipeIndex = 0;
    currentViewMode = 'both'; // 뷰 모드 초기화
}

/**
 * 메시지 업데이트 핸들러
 */
function handleMessageUpdate() {
    // 새 메시지가 추가되거나 업데이트될 때 아이콘 추가
    setTimeout(() => {
        addSwipeViewerIconsToMessages();
    }, 100);
}

/**
 * 확장 초기화
 */
function initializeSwipeViewer() {
    console.log(`[${pluginName}] 스와이프 뷰어 확장 초기화 중...`);
    
    // 기존 메시지에 아이콘 추가
    addSwipeViewerIconsToMessages();
    
    // 이벤트 리스너 설정
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
    eventSource.on(event_types.CHAT_CHANGED, handleMessageUpdate);
    
    // 스와이프 뷰어 아이콘 클릭 이벤트
    $(document).on('click', '.swipe-viewer-icon', async function(event) {
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        if (messageId !== undefined) {
            const messageIndex = parseInt(messageId);
            await createSwipeViewerPopup(messageIndex);
        }
    });
    
    console.log(`[${pluginName}] 스와이프 뷰어 확장 초기화 완료!`);
}

// 이벤트 위임으로 처리하므로 전역 함수 설정 불필요
console.log('[스와이프 뷰어] 복사 기능이 이벤트 위임으로 처리됩니다');

// jQuery 준비 완료 시 초기화
jQuery(() => {
    console.log('[스와이프 뷰어] jQuery 준비 완료, 초기화 시작');
    initializeSwipeViewer();
});