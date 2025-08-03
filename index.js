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
    reloadMarkdownProcessor,
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

// 마크다운 converter
let markdownConverter = null;

/**
 * 마크다운 컨버터 초기화
 */
function initMarkdownConverter() {
    if (!markdownConverter) {
        markdownConverter = reloadMarkdownProcessor();
    }
    return markdownConverter;
}

/**
 * 텍스트를 마크다운으로 렌더링
 */
function renderMarkdown(text) {
    if (!text) return '';
    
    try {
        const converter = initMarkdownConverter();
        return converter.makeHtml(text);
    } catch (error) {
        console.warn('[SwipeViewer] 마크다운 렌더링 중 오류:', error);
        // 마크다운 렌더링에 실패하면 원본 텍스트 반환 (HTML escape 처리)
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }
}

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
    
    // 최초 팝업 생성 시에도 복사 버튼 이벤트 등록
    const originalText = swipeData.swipes[currentSwipeIndex] || '';
    setupCopyButtonEvents(backdrop, originalText, translation);
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
 * 텍스트 복사하기 (LALib 방식 참고)
 */
function copyToClipboard(text, button) {
    if (!text || !button) return;
    
    try {
        navigator.clipboard.writeText(text.toString()).then(() => {
            showCopyFeedback(button, true);
        }).catch(err => {
            fallbackCopy(text, button);
        });
    } catch (err) {
        fallbackCopy(text, button);
    }
}

/**
 * 폴백 복사 방법 (LALib 방식)
 */
function fallbackCopy(text, button) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text.toString();
        ta.style.position = 'fixed';
        ta.style.inset = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(ta);
        showCopyFeedback(button, successful);
    } catch (err) {
        showCopyFeedback(button, false);
    }
}

/**
 * 복사 피드백 표시
 */
function showCopyFeedback(button, success) {
    const originalHtml = button.innerHTML;
    const originalColor = button.style.color;
    
    if (success) {
        button.innerHTML = '<i class="fa-solid fa-check"></i>';
        button.style.color = '#4CAF50';
    } else {
        button.innerHTML = '<i class="fa-solid fa-times"></i>';
        button.style.color = '#f44336';
    }
    
    setTimeout(() => {
        button.innerHTML = originalHtml;
        button.style.color = originalColor;
    }, 1500);
}

/**
 * 복사 버튼 이벤트 등록
 */
function setupCopyButtonEvents(modal, originalText, translation) {
    const copyButtons = modal.find('.copy-btn');
    if (copyButtons.length === 0) return;
    
    copyButtons.each(function(index, button) {
        const $button = $(button);
        
        // 기존 이벤트 제거
        $button.off('click.swipeviewer');
        
        // 버튼이 속한 영역에 따라 텍스트 결정
        let textToCopy = '';
        const parentContainer = $button.closest('.swipe-text-container');
        const headerLabel = $button.closest('.swipe-text-header').find('.swipe-text-label');
        
        if (parentContainer.hasClass('single-view')) {
            // 단일 뷰의 경우
            if (headerLabel.text().includes('원문')) {
                textToCopy = originalText;
            } else if (headerLabel.text().includes('번역문')) {
                textToCopy = translation;
            } else {
                // 라벨이 없는 경우 (번역문이 없을 때)
                textToCopy = originalText;
            }
        } else if (parentContainer.hasClass('dual-view')) {
            // 이중 뷰의 경우
            if (headerLabel.text().includes('원문')) {
                textToCopy = originalText;
            } else {
                textToCopy = translation;
            }
        }
        
        // 클릭 이벤트 등록 - 원본 텍스트(마크다운 포함)를 복사
        $button.on('click.swipeviewer', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            if (textToCopy) {
                copyToClipboard(textToCopy, button);
            }
        });
    });
}

/**
 * 스와이프 콘텐츠 HTML 생성 (번역문 유무 및 뷰 모드에 따라 다르게)
 * 마크다운을 렌더링해서 표시
 */
function createSwipeContentHTML(originalText, translation, hasTranslation) {
    // 마크다운 렌더링
    const renderedOriginal = renderMarkdown(originalText);
    const renderedTranslation = translation ? renderMarkdown(translation) : '';
    
    // 번역문이 없으면 원문만 표시
    if (!hasTranslation) {
        return `
            <div class="swipe-text-container single-view">
                <div class="swipe-text-header">
                    <label class="swipe-text-label">원문</label>
                    <button class="copy-btn" title="원문 복사">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
                <div class="swipe-text-content single-text">${renderedOriginal}</div>
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
                        <button class="copy-btn" title="원문 복사">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                    <div class="swipe-text-content original-text single-mode">${renderedOriginal}</div>
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
                        <button class="copy-btn" title="번역문 복사">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                    <div class="swipe-text-content translation-text single-mode">${renderedTranslation}</div>
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
                            <button class="copy-btn" title="원문 복사">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                        <div class="swipe-text-content original-text">${renderedOriginal}</div>
                    </div>
                    <div class="swipe-text-section">
                        <div class="swipe-text-header">
                            <label class="swipe-text-label">번역문</label>
                            <button class="copy-btn" title="번역문 복사">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                        <div class="swipe-text-content translation-text">${renderedTranslation}</div>
                    </div>
                </div>
            `;
    }
}

/**
 * 팝업 이벤트 핸들러 설정
 */
function setupPopupEventHandlers() {
    const modal = $(`#${MODAL_ID}`);
    
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
async function navigateSwipe(direction) {
    const swipeData = getSwipeData(currentMessageIndex);
    if (!swipeData) return;
    
    const newIndex = currentSwipeIndex + direction;
    if (newIndex < 0 || newIndex >= swipeData.swipes.length) return;
    
    currentSwipeIndex = newIndex;
    await updateSwipeDisplay();
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
    
    // 복사 버튼 이벤트 등록 (새로 생성된 버튼들에 대해)
    setupCopyButtonEvents(modal, originalText, translation);
    
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
    
    // 마크다운 컨버터 초기화
    initMarkdownConverter();
    
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

// 복사 기능이 직접 이벤트 등록 방식으로 처리됨
console.log('[스와이프 뷰어] 복사 기능이 직접 이벤트 등록 방식으로 처리됩니다');

// jQuery 준비 완료 시 초기화
jQuery(() => {
    console.log('[스와이프 뷰어] jQuery 준비 완료, 초기화 시작');
    initializeSwipeViewer();
});