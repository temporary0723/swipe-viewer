// 스와이프 뷰어 확장 - SillyTavern Extension
// 메시지의 지난 스와이프들을 확인할 수 있는 기능 제공

import {
    eventSource,
    event_types,
    chat,
    addOneMessage,
    getRequestHeaders,
    saveSettingsDebounced,
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

/**
 * 메시지에 스와이프 뷰어 아이콘 추가
 */
function addSwipeViewerIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const buttonContainer = messageElement.find('.mes_block .ch_name .mes_buttons');
        
        // 이미 버튼이 있거나 버튼 컨테이너가 없으면 스킵
        if (buttonContainer.length && !buttonContainer.find('.swipe-viewer-icon').length) {
            const buttons = buttonContainer.children('.mes_button');
            if (buttons.length >= 2) {
                // 마지막에서 두 번째 버튼 앞에 추가
                buttons.eq(-2).before(messageButtonHtml);
            } else {
                // 처음에 추가
                buttonContainer.prepend(messageButtonHtml);
            }
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
function createSwipeViewerPopup(messageIndex) {
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
    
    // 백드롭 생성
    const backdrop = $(`
        <div id="${MODAL_ID}" class="swipe-viewer-backdrop">
            <div class="swipe-viewer-modal">
                <div class="swipe-viewer-header">
                    <h3>스와이프 뷰어 (${currentSwipeIndex + 1}/${swipeData.swipes.length})</h3>
                    <button class="swipe-viewer-close" title="닫기">×</button>
                </div>
                <div class="swipe-viewer-body">
                    <div class="swipe-viewer-navigation">
                        <button class="swipe-nav-btn swipe-prev" title="이전 스와이프" ${currentSwipeIndex === 0 ? 'disabled' : ''}>
                            &lt;
                        </button>
                        <div class="swipe-viewer-content">
                            <textarea readonly class="swipe-text-area">${swipeData.swipes[currentSwipeIndex] || ''}</textarea>
                        </div>
                        <button class="swipe-nav-btn swipe-next" title="다음 스와이프" ${currentSwipeIndex >= swipeData.swipes.length - 1 ? 'disabled' : ''}>
                            &gt;
                        </button>
                    </div>
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
function updateSwipeDisplay() {
    const swipeData = getSwipeData(currentMessageIndex);
    if (!swipeData) return;
    
    const modal = $(`#${MODAL_ID}`);
    
    // 헤더 업데이트
    modal.find('.swipe-viewer-header h3').text(`스와이프 뷰어 (${currentSwipeIndex + 1}/${swipeData.swipes.length})`);
    
    // 텍스트 영역 업데이트
    modal.find('.swipe-text-area').val(swipeData.swipes[currentSwipeIndex] || '');
    
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
    $(document).on('click', '.swipe-viewer-icon', function(event) {
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        if (messageId !== undefined) {
            const messageIndex = parseInt(messageId);
            createSwipeViewerPopup(messageIndex);
        }
    });
    
    console.log(`[${pluginName}] 스와이프 뷰어 확장 초기화 완료!`);
}

// jQuery 준비 완료 시 초기화
jQuery(() => {
    initializeSwipeViewer();
});