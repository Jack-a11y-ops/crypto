/**
 * SNR TRACER - Core JavaScript
 * 實作幣安數據獲取、圖表渲染與支撐壓力分析演算法
 */

class SNRTracer {
    constructor() {
        this.symbol = 'BTCUSDT';
        this.interval = '1h';
        this.chart = null;
        this.candlestickSeries = null;
        this.klines = [];
        this.loader = document.getElementById('loader');
        this.authOverlay = document.getElementById('auth-overlay');
        this.currentUser = null;
        this.db = null; // Firebase Firestore 實例
        this.priceLines = []; // 儲存圖表上的支撐壓力與 TP/SL 價格輔助線
        this.equityChart = null; // 模擬收益曲線圖表
        this.equityLineSeries = null; // 模擬收益折線圖
        this.alertCooldowns = {}; // 記錄各幣種臨界警報的冷卻時間戳記
        this.autoScanTimer = null; // 自動雷達掃描計時器
        this.notifiedOpportunities = {}; // 記錄已通知過的交易機會，防重複發信
        this.modalChart = null; // 歷史複盤 Modal 圖表實例
        this.modalCandlestickSeries = null;
        this.modalPriceLines = [];
        this.tpPriceLine = null; // 儲存 Modal 的 TP 價格線實例
        this.slPriceLine = null; // 儲存 Modal 的 SL 價格線實例
        this.currentDragRecord = null; // 儲存當前點選的歷史紀錄資料
        this.isDraggingTP = false; // 是否正在拖曳 TP 線
        this.isDraggingSL = false; // 是否正在拖曳 SL 線

        this.init();
    }

    async init() {
        this.initFirebase(); // 初始化 Firebase
        this.initChart();
        this.initEquityChart(); // 初始化模擬收益曲線圖表
        this.bindEvents();
        this.initAuth(); // 啟動身份驗證流程
        this.requestNotificationPermission(); // 請求通知權限
        this.initEmailJS(); // 初始化 EmailJS 設定
    }

    initChart() {
        const chartElement = document.getElementById('tv-chart');
        this.chart = LightweightCharts.createChart(chartElement, {
            layout: {
                background: { color: 'transparent' },
                textColor: '#848e9c',
                fontSize: 12,
                fontFamily: 'Inter',
            },
            grid: {
                vertLines: { color: 'rgba(197, 203, 206, 0.05)' },
                horzLines: { color: 'rgba(197, 203, 206, 0.05)' },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: 'rgba(197, 203, 206, 0.1)' },
            timeScale: {
                borderColor: 'rgba(197, 203, 206, 0.1)',
                timeVisible: true
            },
        });

        this.candlestickSeries = this.chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: '#0ecb81',
            downColor: '#f6465d',
            borderVisible: false,
            wickUpColor: '#0ecb81',
            wickDownColor: '#f6465d',
            priceFormat: {
                type: 'price',
                precision: 8, // 最大小數位數
                minMove: 0.00000001,
            }
        });


        window.addEventListener('resize', () => {
            this.chart.applyOptions({ width: chartElement.clientWidth, height: chartElement.clientHeight });
        });
    }

    initEquityChart() {
        const chartElement = document.getElementById('history-equity-chart');
        if (!chartElement) return;

        this.equityChart = LightweightCharts.createChart(chartElement, {
            layout: {
                background: { color: 'transparent' },
                textColor: '#848e9c',
                fontSize: 11,
                fontFamily: 'Inter',
            },
            grid: {
                vertLines: { color: 'rgba(197, 203, 206, 0.03)' },
                horzLines: { color: 'rgba(197, 203, 206, 0.03)' },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: 'rgba(197, 203, 206, 0.08)' },
            timeScale: {
                borderColor: 'rgba(197, 203, 206, 0.08)',
                timeVisible: true
            },
        });

        this.equityLineSeries = this.equityChart.addSeries(LightweightCharts.LineSeries, {
            color: '#f0b90b', // Binance 金黃色曲線
            lineWidth: 3,
            priceFormat: {
                type: 'price',
                precision: 2,
            }
        });

        window.addEventListener('resize', () => {
            if (this.equityChart && chartElement) {
                this.equityChart.applyOptions({
                    width: chartElement.clientWidth,
                    height: chartElement.clientHeight
                });
            }
        });
    }

    requestNotificationPermission() {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                Notification.requestPermission();
            }
        }
    }

    playAlertSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            
            // 第一個音 (叮)
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5 音符
            gain1.gain.setValueAtTime(0.15, ctx.currentTime);
            gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6); // 0.6秒內衰減
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.start();
            osc1.stop(ctx.currentTime + 0.6);
            
            // 第二個音 (咚) - 延時 150 毫秒播放
            setTimeout(() => {
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(659.25, ctx.currentTime); // E5 音符
                gain2.gain.setValueAtTime(0.15, ctx.currentTime);
                gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.start();
                osc2.stop(ctx.currentTime + 0.8);
            }, 150);
        } catch (e) {
            console.error("Audio Context playback error:", e);
        }
    }

    showNotification(title, body) {
        this.playAlertSound(); // 發送通知時播放提示音
        
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, {
                body: body,
                icon: 'https://cdn-icons-png.flaticon.com/512/1201/1201584.png' // 加密貨幣主題小圖標
            });
        }
    }

    checkPriceProximityAlert(symbol, price, support, resistance) {
        const now = Date.now();
        const limit = 0.005; // 0.5% 臨界百分比
        const cleanSymbol = symbol.replace('USDT', '');

        if (support) {
            const dist = Math.abs(price - support.value) / price;
            if (dist < limit) {
                const cooldownKey = `${symbol}_support_${support.value.toFixed(4)}`;
                // 10 分鐘冷卻期 (10 * 60 * 1000)
                if (!this.alertCooldowns[cooldownKey] || (now - this.alertCooldowns[cooldownKey]) > 10 * 60 * 1000) {
                    this.showNotification(
                        `🔔 價格接近關鍵支撐位！`,
                        `${cleanSymbol} 現價 $${this.formatPrice(price)}，距離支撐位 $${this.formatPrice(support.value)} 僅 ${(dist * 100).toFixed(2)}%。`
                    );
                    this.alertCooldowns[cooldownKey] = now;
                }
            }
        }

        if (resistance) {
            const dist = Math.abs(price - resistance.value) / price;
            if (dist < limit) {
                const cooldownKey = `${symbol}_resistance_${resistance.value.toFixed(4)}`;
                if (!this.alertCooldowns[cooldownKey] || (now - this.alertCooldowns[cooldownKey]) > 10 * 60 * 1000) {
                    this.showNotification(
                        `🔔 價格接近關鍵壓力位！`,
                        `${cleanSymbol} 現價 $${this.formatPrice(price)}，距離壓力位 $${this.formatPrice(resistance.value)} 僅 ${(dist * 100).toFixed(2)}%。`
                    );
                    this.alertCooldowns[cooldownKey] = now;
                }
            }
        }
    }

    bindEvents() {
        // Tab 切換監聽
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTabId = e.target.dataset.tab;
                this.switchTab(targetTabId);
            });
        });

        // 搜尋按鈕
        document.getElementById('search-btn').addEventListener('click', async () => {
            const input = document.getElementById('pair-input').value.toUpperCase().replace('/', '');
            if (input) {
                this.symbol = input;
                this.switchTab('single-coin-tab'); // 自動切換回單幣分析
                await this.fetchAndAnalyze();
            }
        });

        // 搜尋輸入框的 Enter 事件
        document.getElementById('pair-input').addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const input = document.getElementById('pair-input').value.toUpperCase().replace('/', '');
                if (input) {
                    this.symbol = input;
                    this.switchTab('single-coin-tab'); // 自動切換回單幣分析
                    await this.fetchAndAnalyze();
                }
            }
        });

        // 時間週期按鈕 (單幣分析)
        document.querySelectorAll('.interval-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const newInterval = e.target.dataset.interval;
                this.updateIntervalUI(newInterval);
                this.interval = newInterval;
                this.fetchAndAnalyze();
            });
        });

        // 時間週期按鈕 (全市場雷達掃描)
        document.querySelectorAll('.radar-interval-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const newInterval = e.target.dataset.interval;
                this.updateIntervalUI(newInterval);
                this.interval = newInterval;
            });
        });

        // 全市場雷達立即重新整理按鈕
        document.getElementById('rescan-btn').addEventListener('click', () => {
            this.scanMarket();
        });

        // 風險與槓桿計算器輸入監聽
        const customSlInput = document.getElementById('calc-custom-sl');
        const lossRatioInput = document.getElementById('calc-loss-ratio');
        if (customSlInput && lossRatioInput) {
            customSlInput.addEventListener('input', () => this.calculateLeverage());
            lossRatioInput.addEventListener('input', () => this.calculateLeverage());
        }

        // 訪客登入按鈕監聽
        const guestBtn = document.getElementById('guest-login-btn');
        if (guestBtn) {
            guestBtn.addEventListener('click', () => {
                const mockUser = {
                    name: '體驗訪客',
                    picture: 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y',
                    email: 'guest@example.com',
                    isGuest: true // 標註為訪客以套用次數限制
                };
                localStorage.setItem('snr_user', JSON.stringify(mockUser));
                this.loginSuccess(mockUser);
            });
        }

        // 登出按鈕監聽
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                localStorage.removeItem('snr_user');
                window.location.reload();
            });
        }

        // Google Client ID 設定面板切換監聽
        const toggleConfigBtn = document.getElementById('toggle-config-btn');
        const configPanel = document.getElementById('config-panel');
        if (toggleConfigBtn && configPanel) {
            toggleConfigBtn.addEventListener('click', (e) => {
                e.preventDefault();
                configPanel.classList.toggle('hidden');
            });
        }

        // 儲存 Google Client ID 監聽
        const saveClientIdBtn = document.getElementById('save-client-id-btn');
        const clientIdInput = document.getElementById('client-id-input');
        if (saveClientIdBtn && clientIdInput) {
            saveClientIdBtn.addEventListener('click', () => {
                const val = clientIdInput.value.trim();
                if (val) {
                    localStorage.setItem('snr_google_client_id', val);
                    alert('自訂 Google Client ID 儲存成功！網頁將重新載入以套用設定。');
                } else {
                    localStorage.removeItem('snr_google_client_id');
                    alert('自訂 Google Client ID 已清除，將還原為系統預設值。網頁將重新載入。');
                }
                window.location.reload();
            });
        }

        // 清除歷史紀錄按鈕監聽
        const clearHistoryBtn = document.getElementById('clear-history-btn');
        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', () => {
                if (this.currentUser) {
                    if (confirm('確定要清除所有歷史分析紀錄嗎？此動作無法復原。')) {
                        localStorage.removeItem(`snr_history_${this.currentUser.email}`);
                        this.renderHistory();
                        this.syncToCloud(); // 清除後同步至雲端
                    }
                }
            });
        }

        // 更新即時價格按鈕監聽
        const refreshPricesBtn = document.getElementById('refresh-prices-btn');
        if (refreshPricesBtn) {
            refreshPricesBtn.addEventListener('click', async () => {
                refreshPricesBtn.innerText = '正在更新...';
                refreshPricesBtn.disabled = true;
                try {
                    await this.checkHistorySettlement();
                } catch (e) {
                    console.error(e);
                } finally {
                    refreshPricesBtn.innerText = '更新價格';
                    refreshPricesBtn.disabled = false;
                }
            });
        }

        // 歷史紀錄篩選下拉選單監聽
        const filterDirSelect = document.getElementById('history-filter-direction');
        if (filterDirSelect) {
            filterDirSelect.addEventListener('change', () => {
                this.renderHistory(false); // 僅重新渲染過濾，不需重新發起請求
            });
        }

        // 歷史紀錄篩選時間週期選單監聽
        const filterIntervalSelect = document.getElementById('history-filter-interval');
        if (filterIntervalSelect) {
            filterIntervalSelect.addEventListener('change', () => {
                this.renderHistory(false); // 僅重新渲染過濾
            });
        }

        // 模擬收益頁面篩選下拉選單監聽
        const eqFilterDir = document.getElementById('equity-filter-direction');
        if (eqFilterDir) {
            eqFilterDir.addEventListener('change', () => {
                this.updateEquityCurveTab();
            });
        }
        const eqFilterInterval = document.getElementById('equity-filter-interval');
        if (eqFilterInterval) {
            eqFilterInterval.addEventListener('change', () => {
                this.updateEquityCurveTab();
            });
        }

        // 儲存信箱設定按鈕監聽
        const saveEmailConfigBtn = document.getElementById('save-email-config-btn');
        if (saveEmailConfigBtn) {
            saveEmailConfigBtn.addEventListener('click', () => {
                this.saveEmailConfig();
            });
        }

        // 測試發送郵件按鈕監聽
        const testEmailBtn = document.getElementById('test-email-btn');
        if (testEmailBtn) {
            testEmailBtn.addEventListener('click', () => {
                this.sendTestEmail();
            });
        }

        // 歷史 K 線 Modal 關閉監聽
        const closeModalBtn = document.getElementById('close-modal-btn');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => this.closeHistoryChartModal());
        }
        const modalOverlay = document.getElementById('history-chart-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) {
                    this.closeHistoryChartModal();
                }
            });
        }
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeHistoryChartModal();
            }
        });

        // 綁定 K 線圖拖曳止盈線相關事件
        const modalChartContainer = document.getElementById('modal-tv-chart');
        if (modalChartContainer) {
            modalChartContainer.addEventListener('mousedown', (e) => this.handleChartMouseDown(e));
            modalChartContainer.addEventListener('mousemove', (e) => this.handleChartMouseMove(e));
            window.addEventListener('mouseup', (e) => this.handleChartMouseUp(e));
        }
    }

    // 切換 Tab 輔助函式
    switchTab(tabId) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.dataset.tab === tabId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        document.querySelectorAll('.tab-content').forEach(content => {
            if (content.id === tabId) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });
        
        // 當選擇全市場雷達掃描時，隱藏頂部單幣資訊與單幣搜尋框，只保留標誌
        const marketInfoEl = document.getElementById('market-info');
        const searchBarEl = document.querySelector('.search-bar');
        
        if (tabId === 'market-radar-tab' || tabId === 'history-tab' || tabId === 'equity-curve-tab') {
            if (marketInfoEl) marketInfoEl.classList.add('hidden');
            if (searchBarEl) searchBarEl.classList.add('hidden');
        } else {
            if (marketInfoEl) marketInfoEl.classList.remove('hidden');
            if (searchBarEl) searchBarEl.classList.remove('hidden');
        }
        
        // 切換回單幣詳細分析時，重新調整 TradingView 圖表大小以填滿容器
        if (tabId === 'single-coin-tab') {
            setTimeout(() => {
                const chartElement = document.getElementById('tv-chart');
                if (this.chart && chartElement) {
                    this.chart.applyOptions({
                        width: chartElement.clientWidth,
                        height: chartElement.clientHeight
                    });
                }
            }, 50);
        }

        // 切換到歷史紀錄 Tab 時，渲染歷史紀錄列表
        if (tabId === 'history-tab') {
            this.renderHistory();
        }

        // 切換到模擬收益曲線 Tab 時，更新收益數據並自適應圖表大小
        if (tabId === 'equity-curve-tab') {
            this.updateEquityCurveTab();
            setTimeout(() => {
                const chartElement = document.getElementById('history-equity-chart');
                if (this.equityChart && chartElement) {
                    this.equityChart.applyOptions({
                        width: chartElement.clientWidth,
                        height: chartElement.clientHeight
                    });
                }
            }, 50);
        }
    }

    // 更新全局的週期按鈕 UI 狀態與統計卡片顯示
    updateIntervalUI(interval) {
        // 更新單幣分析按鈕狀態
        document.querySelectorAll('.interval-btn').forEach(b => {
            if (b.dataset.interval === interval) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
        
        // 更新雷達掃描按鈕狀態
        document.querySelectorAll('.radar-interval-btn').forEach(b => {
            if (b.dataset.interval === interval) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });

        // 更新雷達面板的統計卡片
        const statInterval = document.getElementById('radar-stat-interval');
        if (statInterval) {
            statInterval.innerText = interval.toUpperCase();
        }
    }

    // 風險與槓桿計算器計算邏輯
    calculateLeverage() {
        const customSLEl = document.getElementById('calc-custom-sl');
        const lossRatioEl = document.getElementById('calc-loss-ratio');
        const resultEl = document.getElementById('calc-leverage-result');
        
        if (!customSLEl || !lossRatioEl || !resultEl) return;
        
        const customSL = parseFloat(customSLEl.value);
        const lossRatio = parseFloat(lossRatioEl.value);
        
        if (isNaN(customSL) || isNaN(lossRatio) || customSL <= 0 || lossRatio <= 0) {
            resultEl.innerText = '--';
            return;
        }
        
        const leverage = lossRatio / customSL;
        
        // 限制最大槓桿倍數為 125x，若超出則加註提示與紅色警告
        if (leverage > 125) {
            resultEl.innerText = `${leverage.toFixed(1)}x (超限)`;
            resultEl.style.color = '#f6465d';
        } else {
            resultEl.innerText = `${leverage.toFixed(1)}x`;
            resultEl.style.color = '#f0b90b';
        }
    }

    // 身份驗證初始化
    initAuth() {
        const storedUser = localStorage.getItem('snr_user');
        if (storedUser) {
            try {
                const user = JSON.parse(storedUser);
                this.loginSuccess(user);
            } catch (e) {
                this.showAuth(true);
            }
        } else {
            this.showAuth(true);
        }
    }

    showAuth(show) {
        const marketInfoEl = document.getElementById('market-info');
        const searchBarEl = document.querySelector('.search-bar');

        if (show) {
            this.authOverlay.classList.remove('hidden');
            if (marketInfoEl) marketInfoEl.classList.add('hidden');
            if (searchBarEl) searchBarEl.classList.add('hidden');
            this.initGoogleSignIn();
            this.showLoader(false); // 顯示登入遮罩時，確保隱藏加載動畫以防阻擋登入
        } else {
            this.authOverlay.classList.add('hidden');
            // 登入成功後，根據當前 Active Tab 來決定是否顯示頂部單幣資訊與搜尋框
            const activeTab = document.querySelector('.tab-btn.active');
            const activeTabId = activeTab ? activeTab.dataset.tab : 'single-coin-tab';
            if (activeTabId === 'single-coin-tab') {
                if (marketInfoEl) marketInfoEl.classList.remove('hidden');
                if (searchBarEl) searchBarEl.classList.remove('hidden');
            } else {
                if (marketInfoEl) marketInfoEl.classList.add('hidden');
                if (searchBarEl) searchBarEl.classList.add('hidden');
            }
        }
    }

    initGoogleSignIn() {
        if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
            const storedClientId = localStorage.getItem('snr_google_client_id');
            const clientId = storedClientId || '965376510486-lhrmr75b719omptj8v95n8r7tkkvfq4d.apps.googleusercontent.com';
            
            // 若之前有自訂 Client ID，預填入輸入框中
            const idInput = document.getElementById('client-id-input');
            if (idInput && storedClientId) {
                idInput.value = storedClientId;
            }

            google.accounts.id.initialize({
                client_id: clientId,
                callback: (response) => this.handleCredentialResponse(response)
            });
            google.accounts.id.renderButton(
                document.getElementById('google-signin-btn'),
                { theme: 'outline', size: 'large', width: 340 }
            );
        } else {
            // SDK 尚未完成載入，過 300ms 後重試
            setTimeout(() => this.initGoogleSignIn(), 300);
        }
    }

    handleCredentialResponse(response) {
        const userData = this.parseJwt(response.credential);
        if (userData) {
            const user = {
                name: userData.name,
                picture: userData.picture,
                email: userData.email
            };
            localStorage.setItem('snr_user', JSON.stringify(user));
            this.loginSuccess(user);
        }
    }

    parseJwt(token) {
        try {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(jsonPayload);
        } catch (e) {
            return null;
        }
    }

    async loginSuccess(user) {
        this.showAuth(false);
        this.currentUser = user; // 保存當前登入使用者資訊
        
        // 更新個人資料 UI
        const userProfile = document.getElementById('user-profile');
        const userAvatar = document.getElementById('user-avatar');
        const userName = document.getElementById('user-name');
        const userLimitEl = document.getElementById('user-limit');
        
        if (userProfile && userAvatar && userName) {
            userAvatar.src = user.picture;
            userName.innerText = user.name;
            userProfile.classList.remove('hidden');
        }

        // 訪客次數限制 UI 控制
        if (user.isGuest) {
            const count = parseInt(localStorage.getItem('guest_analysis_count') || '0');
            if (userLimitEl) {
                userLimitEl.innerText = `剩餘次數: ${Math.max(0, 3 - count)}次`;
                userLimitEl.classList.remove('hidden');
            }
        } else {
            if (userLimitEl) {
                userLimitEl.classList.add('hidden');
            }
        }

        // 優先從 Firebase 雲端資料庫載入同步該使用者的最新設定與歷史紀錄
        if (this.db) {
            try {
                // Realtime Database 鍵值不允許有點 (.)，將其替換為底線 (_)
                const safeEmail = user.email.replace(/\./g, '_');
                const dbRef = this.db.ref('users/' + safeEmail);
                const snapshot = await dbRef.once('value');
                if (snapshot.exists()) {
                    const cloudData = snapshot.val();
                    
                    if (cloudData.lastSymbol) {
                        this.symbol = cloudData.lastSymbol;
                        const pairInput = document.getElementById('pair-input');
                        if (pairInput) {
                            pairInput.value = cloudData.lastSymbol;
                        }
                    }
                    if (cloudData.lastInterval) {
                        this.interval = cloudData.lastInterval;
                        this.updateIntervalUI(cloudData.lastInterval);
                    }
                    if (cloudData.history) {
                        localStorage.setItem(`snr_history_${user.email}`, JSON.stringify(cloudData.history));
                    }
                    if (cloudData.emailConfig) {
                        localStorage.setItem(`snr_email_config_${user.email}`, JSON.stringify(cloudData.emailConfig));
                    }
                }
            } catch (e) {
                console.error("Firebase load sync error, falling back to local:", e);
            }
        } else {
            // 讀取該帳戶上次的本地 analysis 設定 (Fallback)
            const lastSymbol = localStorage.getItem(`snr_last_symbol_${user.email}`);
            const lastInterval = localStorage.getItem(`snr_last_interval_${user.email}`);
            if (lastSymbol) {
                this.symbol = lastSymbol;
                const pairInput = document.getElementById('pair-input');
                if (pairInput) {
                    pairInput.value = lastSymbol;
                }
            }
            if (lastInterval) {
                this.interval = lastInterval;
                this.updateIntervalUI(lastInterval);
            }
        }
        
        // 登入成功後載入 EmailJS 設定
        this.initEmailJS();
        
        // 如果是登入的使用者，且不是訪客，則開啟每 20 分鐘的自動雷達掃描
        if (this.currentUser && !this.currentUser.isGuest) {
            this.startAutoRadarScan();
        }
        
        // 登入成功後，主動依據當前 active tab 做切換與初始化渲染 (確保首頁預設為歷史紀錄時能自動加載數據)
        const activeTab = document.querySelector('.tab-btn.active');
        const activeTabId = activeTab ? activeTab.dataset.tab : 'history-tab';
        this.switchTab(activeTabId);

        // 只有在當前預設 active tab 為單幣詳細分析時，才在初始化時加載分析主圖表 (避免預設載入歷史紀錄時產生不必要的 API 請求與計算)
        if (activeTabId === 'single-coin-tab') {
            this.fetchAndAnalyze(true);
        } else {
            this.showLoader(false); // 其他預設分頁不加載單幣分析，直接關閉加載動畫
        }
    }

    async fetchAndAnalyze(isInitial = false) {
        // 如果是體驗訪客，先檢查是否已達 3 次分析上限，若未達上限則立刻扣除次數 (即時回饋)
        if (this.currentUser && this.currentUser.isGuest) {
            let count = parseInt(localStorage.getItem('guest_analysis_count') || '0');
            if (count >= 3) {
                alert('您的訪客免費體驗次數 (3次) 已達上限。請登入 Google 帳戶以使用無限制的專業分析服務！');
                // 登出並引導回登入遮罩
                localStorage.removeItem('snr_user');
                window.location.reload();
                return;
            }
            
            // 一按分析就立刻增加計數器並更新 UI
            count++;
            localStorage.setItem('guest_analysis_count', count);
            const userLimitEl = document.getElementById('user-limit');
            if (userLimitEl) {
                userLimitEl.innerText = `剩餘次數: ${Math.max(0, 3 - count)}次`;
            }
        }

        this.showLoader(true);
        try {
            const data = await this.getBinanceData(this.symbol, this.interval);
            const chartData = data.map(d => ({
                time: d.openTime / 1000,
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close)
            }));
            this.candlestickSeries.setData(chartData);

            const lastPrice = chartData[chartData.length - 1].close;
            document.getElementById('current-price').innerText = `$${this.formatPrice(lastPrice)}`;
            document.getElementById('current-pair').innerText = this.symbol;

            const analysis = this.analyzeSNR(chartData);
            this.updateUIWithAnalysis(analysis, lastPrice);

            // 成功分析完畢後，儲存當前設定 (與帳戶 Email 綁定)
            if (this.currentUser) {
                const email = this.currentUser.email;
                localStorage.setItem(`snr_last_symbol_${email}`, this.symbol);
                localStorage.setItem(`snr_last_interval_${email}`, this.interval);

                // 如果不是網頁剛開啟時的自動初始化分析，且有產生明確信號，才寫入歷史分析紀錄
                if (!isInitial && analysis && (analysis.signal === 'LONG' || analysis.signal === 'SHORT')) {
                    this.saveToHistory(
                        this.symbol,
                        this.interval,
                        analysis.signal,
                        lastPrice,
                        analysis.tp,
                        analysis.sl,
                        analysis.rr
                    );
                }

                // 執行支撐壓力臨界價格警報檢測 (當前幣種現價距離 0.5% 以內時)
                this.checkPriceProximityAlert(this.symbol, lastPrice, analysis.support, analysis.resistance);

                // 異步將最新分析狀態與歷史交易同步至 Firebase 雲端資料庫
                this.syncToCloud();
            }

        } catch (error) {
            console.error('Data Fetch Error:', error);
            alert('無法獲取數據，請檢查幣種代碼是否正確');
        } finally {
            this.showLoader(false);
        }
    }

    async getBinanceData(symbol, interval) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=150`;
        const response = await fetch(url);
        return (await response.json()).map(d => ({
            openTime: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5]
        }));
    }

    calculateEMA(data, period = 50) {
        const k = 2 / (period + 1);
        const emaArr = [];
        let ema = data[0].close;
        emaArr.push(ema);
        for (let i = 1; i < data.length; i++) {
            ema = (data[i].close * k) + (ema * (1 - k));
            emaArr.push(ema);
        }
        return emaArr;
    }

    calculateLastATR(data, period = 14) {
        if (data.length < period) return 0;
        const trArr = [];
        trArr.push(data[0].high - data[0].low);
        for (let i = 1; i < data.length; i++) {
            const tr = Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            );
            trArr.push(tr);
        }
        let atr = 0;
        for (let i = 0; i < period; i++) {
            atr += trArr[i];
        }
        atr = atr / period;
        for (let i = period; i < data.length; i++) {
            atr = (atr * (period - 1) + trArr[i]) / period;
        }
        return atr;
    }

    // 核心 SNR 運算邏輯 (整合 EMA 趨勢與 ATR 波動度)
    analyzeSNR(data) {
        const lastPrice = data[data.length - 1].close;
        const ema50 = this.calculateEMA(data, 50);
        const lastEMA = ema50[ema50.length - 1];
        const prevEMA = ema50[ema50.length - 2];
        const lastATR = this.calculateLastATR(data, 14);

        const pivots = [];
        for (let i = 2; i < data.length - 2; i++) {
            if (data[i].high > data[i - 1].high && data[i].high > data[i - 2].high &&
                data[i].high > data[i + 1].high && data[i].high > data[i + 2].high) {
                pivots.push({ type: 'high', value: data[i].high });
            }
            if (data[i].low < data[i - 1].low && data[i].low < data[i - 2].low &&
                data[i].low < data[i + 1].low && data[i].low < data[i + 2].low) {
                pivots.push({ type: 'low', value: data[i].low });
            }
        }

        // 動態合併閾值 (ATR-based)
        const threshold = lastATR > 0 ? lastATR * 0.8 : lastPrice * 0.006;
        let levels = [];
        pivots.forEach(p => {
            let found = levels.find(l => Math.abs(p.value - l.value) < threshold);
            if (found) {
                found.count++;
                found.value = (found.value + p.value) / 2;
            } else {
                levels.push({ value: p.value, count: 1 });
            }
        });

        levels = levels.filter(l => l.count >= 2).sort((a, b) => b.value - a.value);

        let support = levels.filter(l => l.value < lastPrice * 1.002).sort((a, b) => b.value - a.value)[0];
        let resistance = levels.filter(l => l.value > lastPrice * 0.998).sort((a, b) => a.value - b.value)[0];

        let signal = 'WATCH';
        let rr = 0;
        let sl = 0;
        let tp = 0;

        // 動態進場距離限制 (ATR-based)
        const triggerDist = lastATR > 0 ? lastATR * 1.5 : lastPrice * 0.015;
        
        // 動態止損緩衝 (ATR-based)
        const slBuffer = lastATR > 0 ? lastATR * 1.5 : lastPrice * 0.015;

        if (support && resistance) {
            const distToSupport = lastPrice - support.value;
            const distToResistance = resistance.value - lastPrice;

            if (distToSupport < triggerDist) {
                signal = 'LONG';
                sl = support.value - slBuffer;
                tp = resistance.value;
                rr = (tp - lastPrice) / (lastPrice - sl);
            } else if (distToResistance < triggerDist) {
                signal = 'SHORT';
                sl = resistance.value + slBuffer;
                tp = support.value;
                rr = (lastPrice - tp) / (sl - lastPrice);
            }
        }

        // 趨勢過濾 (EMA-based)
        if (signal === 'LONG') {
            // 如果是空頭趨勢 (價格低於 EMA 且 EMA 下降)，過濾 LONG 訊號
            if (lastPrice < lastEMA && lastEMA < prevEMA) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        } else if (signal === 'SHORT') {
            // 如果是多頭趨勢 (價格高於 EMA 且 EMA 上升)，過濾 SHORT 訊號
            if (lastPrice > lastEMA && lastEMA > prevEMA) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        }

        return { levels, support, resistance, signal, rr, sl, tp, lastATR };
    }

    updateUIWithAnalysis(analysis, currentPrice) {
        const { levels, support, resistance, signal, tp, sl } = analysis;

        // 1. 清除圖表上舊的價格輔助線
        if (this.priceLines) {
            this.priceLines.forEach(line => this.candlestickSeries.removePriceLine(line));
        }
        this.priceLines = [];

        // 2. 繪製當前最關鍵的支撐與壓力線
        if (support) {
            const supportLine = this.candlestickSeries.createPriceLine({
                price: support.value,
                color: 'rgba(14, 203, 129, 0.65)',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: `支撐位 $${this.formatPrice(support.value)}`,
            });
            this.priceLines.push(supportLine);
        }

        if (resistance) {
            const resistanceLine = this.candlestickSeries.createPriceLine({
                price: resistance.value,
                color: 'rgba(246, 70, 93, 0.65)',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: `壓力位 $${this.formatPrice(resistance.value)}`,
            });
            this.priceLines.push(resistanceLine);
        }

        // 3. 繪製交易訊號的 TP 與 SL (若有進場訊號)
        if (signal !== 'WATCH' && support && resistance && tp && sl) {
            const tpLine = this.candlestickSeries.createPriceLine({
                price: tp,
                color: 'rgba(240, 185, 11, 0.85)',
                lineWidth: 2.5,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: `🎯 止盈目標 (TP) $${this.formatPrice(tp)}`,
            });
            this.priceLines.push(tpLine);

            const slLine = this.candlestickSeries.createPriceLine({
                price: sl,
                color: 'rgba(234, 57, 67, 0.85)',
                lineWidth: 2.5,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: `❌ 止損防守 (SL) $${this.formatPrice(sl)}`,
            });
            this.priceLines.push(slLine);
        }

        // 更新 SNR 列表
        const listEl = document.getElementById('levels-list');
        listEl.innerHTML = levels.map(l => `
            <li class="level-pill ${l.value > currentPrice ? 'resistance' : 'support'}">
                <span>${l.value > currentPrice ? '壓力' : '支撐'}位</span>
                <span>$${this.formatPrice(l.value)}</span>
            </li>
        `).join('');


        // 更新信號面板
        const signalType = document.getElementById('signal-type');
        const entryPrice = document.getElementById('entry-price');
        const tpPrice = document.getElementById('tp-price');
        const slPrice = document.getElementById('sl-price');
        const reason = document.getElementById('analysis-reason');

        if (!support || !resistance) {
            signalType.innerText = '數據不足';
            return;
        }

        signalType.innerText = signal === 'LONG' ? '建議買入 (LONG)' : (signal === 'SHORT' ? '建議賣出 (SHORT)' : '區間震盪 (WATCH)');
        signalType.className = `status-badge ${signal === 'LONG' ? 'text-green' : (signal === 'SHORT' ? 'text-red' : '')}`;

        const recommendSlEl = document.getElementById('calc-recommend-sl');
        const customSlInput = document.getElementById('calc-custom-sl');

        if (signal !== 'WATCH' && tp && sl) {
            entryPrice.innerText = `$${this.formatPrice(currentPrice)}`;
            tpPrice.innerText = `$${this.formatPrice(tp)}`;
            slPrice.innerText = `$${this.formatPrice(sl)}`;
            reason.innerText = `檢測到有效 SNR 結構。當前盈虧比 (RR) 為 ${analysis.rr.toFixed(2)}。價格正處於關鍵${signal === 'LONG' ? '支撐' : '壓力'}位附近，符合進場條件。`;
            
            // 計算系統推薦止損距離 %
            const recommendSLPercent = (Math.abs(currentPrice - sl) / currentPrice) * 100;
            if (recommendSlEl) {
                recommendSlEl.innerText = `${recommendSLPercent.toFixed(2)}%`;
            }
            if (customSlInput) {
                customSlInput.value = recommendSLPercent.toFixed(2);
            }
        } else {
            entryPrice.innerText = '等待觸碰邊界';
            tpPrice.innerText = '--';
            slPrice.innerText = '--';
            reason.innerText = '目前價格處於中間地帶，未觸及強大的支撐或壓力區。建議等待更佳的 Risk-Reward 位置。';
            
            if (recommendSlEl) {
                recommendSlEl.innerText = '--';
            }
        }

        // 觸發槓桿計算器更新
        this.calculateLeverage();
    }

    // 市場掃描器實作
    async scanMarket() {
        const radarList = document.getElementById('radar-list');
        const radarCount = document.getElementById('radar-count');
        const radarStatus = document.getElementById('radar-status');
        
        radarStatus.innerText = '正在掃描中...';
        radarList.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 40px; color: var(--text-muted);">正在掃描前 50 大成交量幣種，這大約需要 3-5 秒鐘，請稍候...</td></tr>';

        try {
            // 1. 獲取成交量前 50 大 USDT 交易對
            const tickerUrl = 'https://api.binance.com/api/v3/ticker/24hr';
            const tickers = await (await fetch(tickerUrl)).json();
            const top50 = tickers
                .filter(t => t.symbol.endsWith('USDT'))
                .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
                .slice(0, 50);

            const opportunities = [];

            // 2. 批量分析
            for (const item of top50) {
                try {
                    const data = await this.getBinanceData(item.symbol, this.interval);
                    if (data.length < 100) continue;

                    const chartData = data.map(d => ({
                        close: parseFloat(d.close), high: parseFloat(d.high), low: parseFloat(d.low)
                    }));

                    const analysis = this.analyzeSNR(chartData);

                    // 過濾：信號明確且盈虧比 > 1
                    if (analysis.signal !== 'WATCH' && analysis.rr > 1) {
                        const lastPrice = chartData[chartData.length - 1].close;
                        opportunities.push({
                            symbol: item.symbol,
                            signal: analysis.signal,
                            rr: analysis.rr,
                            tp: analysis.tp,
                            sl: analysis.sl
                        });

                        // 將掃描出的機會寫入歷史紀錄 (此時只存 localStorage，最後統一同步至雲端)
                        this.saveToHistory(
                            item.symbol,
                            this.interval,
                            analysis.signal,
                            lastPrice,
                            analysis.tp,
                            analysis.sl,
                            analysis.rr
                        );
                    }
                } catch (e) {
                    console.warn(`Skip ${item.symbol} due to error`);
                }
            }

            // 去重與通知檢測
            const now = Date.now();
            const newOpportunities = [];
            
            opportunities.forEach(opp => {
                const key = `${opp.symbol}_${this.interval}_${opp.signal}`;
                const lastNotified = this.notifiedOpportunities[key];
                
                // 10 分鐘去重 (10 * 60 * 1000 毫秒)
                if (!lastNotified || (now - lastNotified) > 10 * 60 * 1000) {
                    newOpportunities.push(opp);
                    this.notifiedOpportunities[key] = now;
                }
            });

            if (newOpportunities.length > 0) {
                // 1. 發送 Email 通知
                this.sendEmailNotification(newOpportunities);
                
                // 2. 顯示系統桌面通知（內含提示音效）
                if (newOpportunities.length === 1) {
                    const opp = newOpportunities[0];
                    const cleanSym = opp.symbol.replace('USDT', '');
                    const dir = opp.signal === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
                    this.showNotification(
                        `📬 發現新交易機會！`,
                        `【雷達】${cleanSym} (${this.interval.toUpperCase()}) 建議信號: ${dir}，盈虧比: ${opp.rr.toFixed(2)}。`
                    );
                } else {
                    const symbolsStr = newOpportunities.map(o => o.symbol.replace('USDT', '')).join(', ');
                    this.showNotification(
                        `📬 發現 ${newOpportunities.length} 個新交易機會！`,
                        `【雷達】已偵測到包含 ${symbolsStr} (${this.interval.toUpperCase()}) 在內的新交易機會。`
                    );
                }
            }

            // 批量同步至 Firebase 雲端資料庫
            if (opportunities.length > 0) {
                this.syncToCloud();
            }

            // 3. 更新 UI
            radarCount.innerText = `${opportunities.length} 標的`;
            radarStatus.innerText = '掃描完成';
            
            if (opportunities.length === 0) {
                radarList.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 40px; color: var(--text-muted);">目前無符合高盈虧比 (盈虧比 > 1) 的交易機會</td></tr>';
            } else {
                radarList.innerHTML = opportunities
                    .sort((a, b) => b.rr - a.rr) // 按 RR 排序
                    .map(opp => {
                        const rrPercent = Math.min(opp.rr * 20, 100); // 將 RR 轉化為進度條百分比
                        return `
                            <tr>
                                <td><span class="symbol-name">${opp.symbol.replace('USDT', '')}</span><span style="color: var(--text-muted); font-size: 12px; margin-left: 5px;">/USDT</span></td>
                                <td>
                                    <span class="signal-badge ${opp.signal === 'LONG' ? 'long' : 'short'}">
                                        ${opp.signal === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)'}
                                    </span>
                                </td>
                                <td>
                                    <div class="rr-badge">
                                        <span class="rr-value">${opp.rr.toFixed(2)}</span>
                                        <div class="rr-bar-bg">
                                            <div class="rr-bar-fill" style="width: ${rrPercent}%;"></div>
                                        </div>
                                    </div>
                                </td>
                                <td>
                                    <button class="action-btn" onclick="app.loadPair('${opp.symbol}')">分析詳情</button>
                                </td>
                            </tr>
                        `;
                    }).join('');
            }
        } catch (error) {
            console.error('Scanner Error:', error);
            radarStatus.innerText = '掃描失敗';
            radarList.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--red); padding: 40px;">雷達掃描失敗，請檢查網路連接。</td></tr>';
        }
    }

    loadPair(symbol) {
        this.symbol = symbol;
        document.getElementById('pair-input').value = symbol;
        this.switchTab('single-coin-tab'); // 自動切換回單幣分析
        this.fetchAndAnalyze();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // 動態價格格式化輔助函式
    formatPrice(price) {
        if (typeof price !== 'number') price = parseFloat(price);
        if (price >= 1000) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (price >= 1) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        if (price >= 0.1) return price.toFixed(5);
        if (price >= 0.01) return price.toFixed(6);
        return price.toFixed(8); // 極低價幣種（如 PEPE, SHIB）
    }

    showLoader(show) {
        if (show) {
            this.loader.classList.remove('hidden');
        } else {
            this.loader.classList.add('hidden');
        }
    }

    saveToHistory(symbol, interval, type, entry, tp, sl, rr) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        const now = Date.now();

        // 尋找是否存在同幣種、同週期的 PENDING 舊交易
        const oldPendingIndex = history.findIndex(r => 
            r.symbol === symbol && 
            r.interval === interval && 
            r.status === 'PENDING'
        );

        let replaceOld = false;
        if (oldPendingIndex !== -1) {
            const oldPending = history[oldPendingIndex];
            if (rr > oldPending.rr) {
                // 新的盈虧比較佳，將舊交易改為 CLOSED，並允許寫入新交易
                oldPending.status = 'CLOSED';
                replaceOld = true;
            } else {
                // 舊的盈虧比較佳，跳過新機會
                console.log(`[${symbol}] 舊交易 PENDING 的 rr (${oldPending.rr.toFixed(2)}) 優於或等於新機會 (rr: ${rr.toFixed(2)})，維持舊交易。`);
                return;
            }
        }

        // 防重複：如果不是 replaceOld，且在歷史紀錄中已存在同一個幣種、週期與訊號，且時間在 3 分鐘內，則不重複新增
        const isDuplicate = replaceOld ? false : history.some(item => 
            item.symbol === symbol && 
            item.interval === interval && 
            item.type === type && 
            (now - item.id) < 3 * 60 * 1000
        );
        if (isDuplicate) return;

        const date = new Date(now);
        const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

        const newRecord = {
            id: now,
            timeStr: timeStr,
            symbol: symbol,
            interval: interval,
            type: type,
            entry: entry,
            tp: tp,
            sl: sl,
            rr: rr,
            status: 'PENDING'
        };

        history.unshift(newRecord);

        // 限制只保留最近 100 筆，超出部分刪除
        if (history.length > 100) {
            history = history.slice(0, 100);
        }

        localStorage.setItem(historyKey, JSON.stringify(history));
    }

    renderHistory(shouldCheck = true) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 取得篩選方向與週期設定
        const filterDirSelect = document.getElementById('history-filter-direction');
        const selectedDir = filterDirSelect ? filterDirSelect.value : 'ALL';
        
        const filterIntervalSelect = document.getElementById('history-filter-interval');
        const selectedInterval = filterIntervalSelect ? filterIntervalSelect.value : 'ALL';
        
        let filteredHistory = history;
        if (selectedDir !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.type === selectedDir);
        }
        if (selectedInterval !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.interval === selectedInterval);
        }

        const total = filteredHistory.length;
        const settled = filteredHistory.filter(r => r.status === 'TP' || r.status === 'SL');
        const tpCount = filteredHistory.filter(r => r.status === 'TP').length;
        const slCount = filteredHistory.filter(r => r.status === 'SL').length;
        
        const winRate = settled.length > 0 ? `${((tpCount / settled.length) * 100).toFixed(1)}%` : '--';

        document.getElementById('history-stat-total').innerText = `${total} 筆`;
        document.getElementById('history-stat-settled').innerText = `${settled.length} 筆`;
        document.getElementById('history-stat-winrate').innerText = winRate;
        document.getElementById('history-stat-ratio').innerText = `${tpCount} / ${slCount}`;

        const historyList = document.getElementById('history-list');
        if (!historyList) return;

        if (filteredHistory.length === 0) {
            historyList.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center; padding: 40px; color: var(--text-muted);">
                        ${(selectedDir === 'ALL' && selectedInterval === 'ALL') ? '暫無歷史分析紀錄。請在單幣詳細分析中搜尋並產生有效交易信號。' : '暫無符合篩選條件的歷史分析紀錄。'}
                    </td>
                </tr>
            `;
            return;
        }

        historyList.innerHTML = filteredHistory.map(r => {
            let statusHTML = '';
            if (r.status === 'PENDING') {
                if (r.currentPrice !== undefined && r.percentChange !== undefined) {
                    const percentStr = r.percentChange >= 0 ? `+${r.percentChange.toFixed(2)}%` : `${r.percentChange.toFixed(2)}%`;
                    const percentClass = r.percentChange >= 0 ? 'text-green' : 'text-red';
                    statusHTML = `
                        <span class="status-pill pending">進行中 ⏳</span>
                        <div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">
                            現價: $${this.formatPrice(r.currentPrice)}<br>
                            漲跌: <span class="${percentClass}" style="font-weight: 700;">${percentStr}</span>
                        </div>
                    `;
                } else {
                    statusHTML = `<span class="status-pill pending">進行中 ⏳</span>`;
                }
            } else if (r.status === 'TP') {
                statusHTML = `<span class="status-pill tp">已止盈 🎯</span>`;
            } else if (r.status === 'SL') {
                statusHTML = `<span class="status-pill sl">已止損 ❌</span>`;
            } else if (r.status === 'CLOSED') {
                statusHTML = `<span class="status-pill closed">已平倉 🔄</span>`;
            } else {
                statusHTML = `<span class="status-pill expired">已過期 ⏳</span>`;
            }

            // 計算建議槓桿倍數 (30% 預期虧損)
            const slPercent = (Math.abs(r.entry - r.sl) / r.entry) * 100;
            let leverageHTML = '--';
            if (slPercent > 0) {
                const leverage = 30 / slPercent;
                if (leverage > 125) {
                    leverageHTML = `<span class="text-red" style="font-weight: 700;">${leverage.toFixed(1)}x</span><div style="font-size: 10px; color: var(--text-muted);">(超限)</div>`;
                } else {
                    leverageHTML = `<span style="color: var(--accent-color); font-weight: 700;">${leverage.toFixed(1)}x</span>`;
                }
            }

            const typeClass = r.type === 'LONG' ? 'text-green' : 'text-red';

            return `
                <tr>
                    <td style="font-family: monospace; color: var(--text-muted); font-size: 13px;">${r.timeStr}</td>
                    <td onclick="app.openHistoryChartModal(${r.id})" class="clickable-symbol">
                        <span class="symbol-name" style="color: var(--accent-color); font-weight: bold;">${r.symbol.replace('USDT', '')}</span>
                        <span style="color: var(--text-muted); font-size: 12px; margin-left: 5px;">/USDT (${r.interval.toUpperCase()})</span>
                        <span class="symbol-icon">📈</span>
                    </td>
                    <td>
                        <span class="${typeClass}" style="font-weight: 700;">
                            ${r.type === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)'}
                        </span>
                    </td>
                    <td style="font-family: monospace; font-size: 13px;">
                        <div>進場: $${this.formatPrice(r.entry)}</div>
                        <div class="text-green">止盈: $${this.formatPrice(r.tp)}</div>
                        <div class="text-red">止損: $${this.formatPrice(r.sl)}</div>
                    </td>
                    <td style="text-align: center; font-family: monospace;">
                        ${leverageHTML}
                    </td>
                    <td style="font-family: 'Courier New', monospace; font-weight: 700; font-size: 15px;">
                        ${r.rr.toFixed(2)}
                    </td>
                    <td>${statusHTML}</td>
                    <td>
                        <button class="danger-btn-xs" onclick="app.deleteHistoryRecord(${r.id})">刪除</button>
                    </td>
                </tr>
            `;
        }).join('');

        // 歷史紀錄分頁已無折線圖，移除原先在此對 updateEquityChart 的調用

        if (shouldCheck) {
            this.checkHistorySettlement();
        }
    }

    deleteHistoryRecord(id) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        const recordIndex = history.findIndex(r => r.id === id);
        if (recordIndex !== -1) {
            const record = history[recordIndex];
            if (confirm(`確定要刪除 ${record.symbol.replace('USDT', '')} (${record.interval.toUpperCase()}) 的這筆歷史分析紀錄嗎？`)) {
                history.splice(recordIndex, 1);
                localStorage.setItem(historyKey, JSON.stringify(history));
                
                // 重新渲染歷史紀錄，不需重新發起 API 結算查詢
                this.renderHistory(false);
                
                // 異步同步至雲端資料庫
                this.syncToCloud();
            }
        }
    }

    async openHistoryChartModal(id) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        const record = history.find(r => r.id === id);
        if (!record) return;

        this.currentDragRecord = record; // 保存給拖曳功能使用

        // 1. 填入基本資訊與顯示 Modal
        document.getElementById('modal-title').innerText = `${record.symbol.replace('USDT', '')}/USDT (${record.interval.toUpperCase()}) 歷史回顧`;
        
        const typeBadge = document.getElementById('modal-type');
        typeBadge.innerText = record.type === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
        typeBadge.className = `info-badge ${record.type === 'LONG' ? 'long' : 'short'}`;

        document.getElementById('modal-entry').innerText = `$${this.formatPrice(record.entry)}`;
        document.getElementById('modal-tp').innerText = `$${this.formatPrice(record.tp)}`;
        document.getElementById('modal-sl').innerText = `$${this.formatPrice(record.sl)}`;
        document.getElementById('modal-current').innerText = '載入中...';

        const modal = document.getElementById('history-chart-modal');
        modal.classList.remove('hidden');

        // 2. 初始化 K 線圖表
        const chartContainer = document.getElementById('modal-tv-chart');
        chartContainer.innerHTML = '<div style="text-align:center; padding: 120px 0; color: var(--text-muted); font-size: 14px;">K 線圖表載入中...</div>';

        // 銷毀可能殘留的舊圖表實例
        if (this.modalChart) {
            try {
                this.modalChart.remove();
            } catch (e) {
                console.warn("Destroy old modal chart error:", e);
            }
            this.modalChart = null;
            this.modalCandlestickSeries = null;
            this.modalPriceLines = [];
        }

        // 使用 setTimeout 確保 Modal 已經被渲染並取得正確的 clientWidth/clientHeight
        setTimeout(async () => {
            chartContainer.innerHTML = ''; // 清空載入中提示

            const width = chartContainer.clientWidth || 800;
            const height = chartContainer.clientHeight || 450;

            try {
                this.modalChart = LightweightCharts.createChart(chartContainer, {
                    width: width,
                    height: height,
                    layout: {
                        background: { color: 'transparent' },
                        textColor: '#848e9c',
                        fontSize: 12,
                        fontFamily: 'Inter',
                    },
                    grid: {
                        vertLines: { color: 'rgba(197, 203, 206, 0.05)' },
                        horzLines: { color: 'rgba(197, 203, 206, 0.05)' },
                    },
                    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
                    rightPriceScale: { borderColor: 'rgba(197, 203, 206, 0.1)' },
                    timeScale: {
                        borderColor: 'rgba(197, 203, 206, 0.1)',
                        timeVisible: true
                    },
                });

                this.modalCandlestickSeries = this.modalChart.addSeries(LightweightCharts.CandlestickSeries, {
                    upColor: '#0ecb81',
                    downColor: '#f6465d',
                    borderVisible: false,
                    wickUpColor: '#0ecb81',
                    wickDownColor: '#f6465d',
                    priceFormat: {
                        type: 'price',
                        precision: 8,
                        minMove: 0.00000001,
                    }
                });

                // 3. 獲取當時 K 線資料
                // 計算 interval 對應的毫秒數
                let intervalMs = 60 * 1000;
                if (record.interval === '5m') intervalMs = 5 * 60 * 1000;
                else if (record.interval === '15m') intervalMs = 15 * 60 * 1000;
                else if (record.interval === '1h') intervalMs = 60 * 60 * 1000;
                else if (record.interval === '4h') intervalMs = 4 * 60 * 60 * 1000;
                else if (record.interval === '1d') intervalMs = 24 * 60 * 60 * 1000;

                // 往前推算 500 根 K 線作為查詢起點
                const queryStartTime = record.id - 500 * intervalMs;

                const url = `https://api.binance.com/api/v3/klines?symbol=${record.symbol}&interval=${record.interval}&startTime=${queryStartTime}&limit=1000`;
                const response = await fetch(url);
                const klines = await response.json();

                if (!Array.isArray(klines) || klines.length === 0) {
                    chartContainer.innerHTML = '<div style="text-align:center; padding: 120px 0; color: var(--text-muted);">無法載入 K 線資料</div>';
                    return;
                }

                const chartData = klines.map(d => ({
                    time: d[0] / 1000,
                    open: parseFloat(d[1]),
                    high: parseFloat(d[2]),
                    low: parseFloat(d[3]),
                    close: parseFloat(d[4])
                }));

                this.modalCandlestickSeries.setData(chartData);

                const lastPrice = chartData[chartData.length - 1].close;
                document.getElementById('modal-current').innerText = `$${this.formatPrice(lastPrice)}`;

                // 4. 繪製輔助價格線 (Entry, TP, SL, CurrentPrice)
                this.modalPriceLines = [];

                // 4.1 進場價 (藍虛線)
                const entryLine = this.modalCandlestickSeries.createPriceLine({
                    price: record.entry,
                    color: 'rgba(56, 139, 253, 0.85)',
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: `進場價 $${this.formatPrice(record.entry)}`,
                });
                this.modalPriceLines.push(entryLine);

                // 4.2 止盈目標 (綠實線)
                const tpLine = this.modalCandlestickSeries.createPriceLine({
                    price: record.tp,
                    color: 'rgba(14, 203, 129, 0.85)',
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    axisLabelVisible: true,
                    title: `🎯 止盈位 $${this.formatPrice(record.tp)}`,
                });
                this.modalPriceLines.push(tpLine);
                this.tpPriceLine = tpLine; // 保存給拖曳功能使用

                // 4.3 止損防守 (紅實線)
                const slLine = this.modalCandlestickSeries.createPriceLine({
                    price: record.sl,
                    color: 'rgba(246, 70, 93, 0.85)',
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    axisLabelVisible: true,
                    title: `❌ 止損位 $${this.formatPrice(record.sl)}`,
                });
                this.modalPriceLines.push(slLine);
                this.slPriceLine = slLine; // 保存給拖曳功能使用

                // 4.4 最新現價 (黃實線)
                const currentLine = this.modalCandlestickSeries.createPriceLine({
                    price: lastPrice,
                    color: 'rgba(240, 185, 11, 0.85)',
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    axisLabelVisible: true,
                    title: `現價 $${this.formatPrice(lastPrice)}`,
                });
                this.modalPriceLines.push(currentLine);

            } catch (err) {
                console.error("Load modal chart klines error:", err);
                chartContainer.innerHTML = '<div style="text-align:center; padding: 120px 0; color: var(--red);">載入市場數據失敗，請檢查網路連接。</div>';
            }
        }, 100);
    }

    closeHistoryChartModal() {
        const modal = document.getElementById('history-chart-modal');
        if (modal) {
            modal.classList.add('hidden');
        }

        // 銷毀圖表實例釋放記憶體
        if (this.modalChart) {
            try {
                this.modalChart.remove();
            } catch (e) {
                console.warn("Destroy modal chart error:", e);
            }
            this.modalChart = null;
            this.modalCandlestickSeries = null;
            this.modalPriceLines = [];
            this.tpPriceLine = null;
            this.slPriceLine = null;
            this.currentDragRecord = null;
            this.isDraggingTP = false;
            this.isDraggingSL = false;
        }
        const chartContainer = document.getElementById('modal-tv-chart');
        if (chartContainer) {
            chartContainer.style.cursor = 'default';
        }
        chartContainer.innerHTML = '';
    }

    handleChartMouseDown(e) {
        if (!this.modalChart || !this.modalCandlestickSeries || !this.currentDragRecord) return;
        
        const chartContainer = document.getElementById('modal-tv-chart');
        const rect = chartContainer.getBoundingClientRect();
        const mouseY = e.clientY - rect.top;
        
        // 計算 TP 與 SL 線當前的 Y 座標
        let tpY = null;
        let slY = null;
        if (this.tpPriceLine) {
            tpY = this.modalCandlestickSeries.priceToCoordinate(this.currentDragRecord.tp);
        }
        if (this.slPriceLine) {
            slY = this.modalCandlestickSeries.priceToCoordinate(this.currentDragRecord.sl);
        }
        
        // 12 像素之內點擊視為選中對應線進行拖曳
        let shouldFreeze = false;
        if (tpY !== null && Math.abs(mouseY - tpY) < 12) {
            this.isDraggingTP = true;
            chartContainer.style.cursor = 'ns-resize';
            shouldFreeze = true;
            e.preventDefault(); // 防止選中文字
        } else if (slY !== null && Math.abs(mouseY - slY) < 12) {
            this.isDraggingSL = true;
            chartContainer.style.cursor = 'ns-resize';
            shouldFreeze = true;
            e.preventDefault(); // 防止選中文字
        }

        // 暫時禁用圖表滾動與平移，防止拖曳價格線時 K 線圖位移晃動
        if (shouldFreeze && this.modalChart) {
            this.modalChart.applyOptions({
                handleScroll: {
                    mouseWheel: false,
                    pressedMouseButton: false,
                    touchGesture: false,
                },
                handleScale: {
                    axisPressedMouseMove: false,
                    mouseWheel: false,
                    pinch: false,
                }
            });
        }
    }

    handleChartMouseMove(e) {
        if (!this.modalChart || !this.modalCandlestickSeries || !this.currentDragRecord) return;
        
        const chartContainer = document.getElementById('modal-tv-chart');
        const rect = chartContainer.getBoundingClientRect();
        const mouseY = e.clientY - rect.top;
        const record = this.currentDragRecord;
        
        // 計算 TP 與 SL 線當前的 Y 座標
        let tpY = null;
        let slY = null;
        if (this.tpPriceLine) tpY = this.modalCandlestickSeries.priceToCoordinate(record.tp);
        if (this.slPriceLine) slY = this.modalCandlestickSeries.priceToCoordinate(record.sl);
        
        if (this.isDraggingTP && this.tpPriceLine) {
            // 進行 TP 拖曳
            chartContainer.style.cursor = 'ns-resize';
            const price = this.modalCandlestickSeries.coordinateToPrice(mouseY);
            if (price !== null && price > 0) {
                let validPrice = price;
                if (record.type === 'LONG') {
                    // LONG: TP 不能低於進場價 + 0.1% 緩衝
                    const minTP = record.entry * 1.001;
                    if (validPrice < minTP) validPrice = minTP;
                } else {
                    // SHORT: TP 不能高於進場價 - 0.1% 緩衝
                    const maxTP = record.entry * 0.999;
                    if (validPrice > maxTP) validPrice = maxTP;
                }
                
                const precisionPrice = parseFloat(validPrice.toFixed(8));
                record.tp = precisionPrice;
                
                this.tpPriceLine.applyOptions({
                    price: precisionPrice,
                    title: `🎯 止盈位 (拖曳中) $${this.formatPrice(precisionPrice)}`
                });
                
                const modalTpEl = document.getElementById('modal-tp');
                if (modalTpEl) modalTpEl.innerText = `$${this.formatPrice(precisionPrice)}`;
            }
        } else if (this.isDraggingSL && this.slPriceLine) {
            // 進行 SL 拖曳
            chartContainer.style.cursor = 'ns-resize';
            const price = this.modalCandlestickSeries.coordinateToPrice(mouseY);
            if (price !== null && price > 0) {
                let validPrice = price;
                if (record.type === 'LONG') {
                    // LONG: SL 不能高於進場價 - 0.1% 緩衝
                    const maxSL = record.entry * 0.999;
                    if (validPrice > maxSL) validPrice = maxSL;
                } else {
                    // SHORT: SL 不能低於進場價 + 0.1% 緩衝
                    const minSL = record.entry * 1.001;
                    if (validPrice < minSL) validPrice = minSL;
                }
                
                const precisionPrice = parseFloat(validPrice.toFixed(8));
                record.sl = precisionPrice;
                
                this.slPriceLine.applyOptions({
                    price: precisionPrice,
                    title: `❌ 止損位 (拖曳中) $${this.formatPrice(precisionPrice)}`
                });
                
                const modalSlEl = document.getElementById('modal-sl');
                if (modalSlEl) modalSlEl.innerText = `$${this.formatPrice(precisionPrice)}`;
            }
        } else {
            // 尚未拖曳，滑鼠滑過時如果是靠近 TP/SL 線則顯示拖曳 cursor
            const isNearTP = tpY !== null && Math.abs(mouseY - tpY) < 12;
            const isNearSL = slY !== null && Math.abs(mouseY - slY) < 12;
            if (isNearTP || isNearSL) {
                chartContainer.style.cursor = 'ns-resize';
            } else {
                chartContainer.style.cursor = 'default';
            }
        }
    }

    async handleChartMouseUp(e) {
        if ((!this.isDraggingTP && !this.isDraggingSL) || !this.currentDragRecord) {
            this.isDraggingTP = false;
            this.isDraggingSL = false;
            return;
        }
        
        const wasDraggingTP = this.isDraggingTP;
        const wasDraggingSL = this.isDraggingSL;
        
        this.isDraggingTP = false;
        this.isDraggingSL = false;

        // 重新啟用圖表滾動與平移
        if (this.modalChart) {
            this.modalChart.applyOptions({
                handleScroll: {
                    mouseWheel: true,
                    pressedMouseButton: true,
                    touchGesture: true,
                },
                handleScale: {
                    axisPressedMouseMove: true,
                    mouseWheel: true,
                    pinch: true,
                }
            });
        }
        
        const chartContainer = document.getElementById('modal-tv-chart');
        if (chartContainer) {
            chartContainer.style.cursor = 'default';
        }
        
        const record = this.currentDragRecord;
        
        // 恢復價格線的最終標題
        if (wasDraggingTP && this.tpPriceLine) {
            this.tpPriceLine.applyOptions({
                title: `🎯 止盈位 $${this.formatPrice(record.tp)}`
            });
        }
        if (wasDraggingSL && this.slPriceLine) {
            this.slPriceLine.applyOptions({
                title: `❌ 止損位 $${this.formatPrice(record.sl)}`
            });
        }
        
        // 1. 重新計算該筆紀錄的盈虧比 (R:R)
        // 盈虧比 = |tp - entry| / |entry - sl|
        const risk = Math.abs(record.entry - record.sl);
        if (risk > 0) {
            record.rr = Math.abs(record.tp - record.entry) / risk;
        } else {
            record.rr = 0;
        }
        
        // 2. 更新 LocalStorage
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        try {
            let history = JSON.parse(localStorage.getItem(historyKey) || '[]');
            const index = history.findIndex(r => r.id === record.id);
            if (index !== -1) {
                history[index].tp = record.tp;
                history[index].sl = record.sl;
                history[index].rr = record.rr;
                localStorage.setItem(historyKey, JSON.stringify(history));
                
                // 3. 同步到 Firebase Realtime Database
                if (this.db) {
                    const safeEmail = email.replace(/\./g, '_');
                    await this.db.ref(`users/${safeEmail}/history`).set(history);
                }
            }
        } catch (err) {
            console.error("Save dragged price lines error:", err);
        }
        
        // 4. 重新刷新歷史表格 (不需發送網路請求)
        this.renderHistory(false);
        
        // 5. 重新整理模擬收益曲線，因 R:R 可能已變更
        this.updateEquityCurveTab();
    }

    updateEquityCurveTab() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 取得收益分頁篩選方向與週期設定
        const filterDirSelect = document.getElementById('equity-filter-direction');
        const selectedDir = filterDirSelect ? filterDirSelect.value : 'ALL';
        
        const filterIntervalSelect = document.getElementById('equity-filter-interval');
        const selectedInterval = filterIntervalSelect ? filterIntervalSelect.value : 'ALL';
        
        let filteredHistory = history;
        if (selectedDir !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.type === selectedDir);
        }
        if (selectedInterval !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.interval === selectedInterval);
        }

        this.updateEquityChart(filteredHistory);
    }

    updateEquityChart(records) {
        if (!this.equityLineSeries) return;

        // 1. 將資料進行拷貝並反轉，使其按時間「由舊到新」排序以供折線圖繪製
        const chronologicalRecords = [...records].reverse();
        
        // 2. 過濾出已結算的交易 (TP, SL 或 CLOSED)
        const settledRecords = chronologicalRecords.filter(r => r.status === 'TP' || r.status === 'SL' || r.status === 'CLOSED');
        
        const chartPoints = [];
        let currentPnL = 0;

        // 初始起點：若有交易，可以在第一筆交易的時間往前推 1 小時作為 PnL = 0.00 的起點；若無交易，使用當前時間往前推
        if (settledRecords.length > 0) {
            const firstTime = Math.floor(settledRecords[0].id / 1000) - 3600;
            chartPoints.push({ time: firstTime, value: 0.00 });
        } else {
            chartPoints.push({ time: Math.floor(Date.now() / 1000) - 3600, value: 0.00 });
        }

        let lastTime = chartPoints[0].time;
        settledRecords.forEach(r => {
            const pnlChange = r.status === 'TP' ? r.rr : -1.0;
            currentPnL += pnlChange;
            
            let recordTime = Math.floor(r.id / 1000);
            // 確保時間戳嚴格遞增 (Lightweight Charts 規定)，防止因同秒內產生多筆訊號而報錯
            if (recordTime <= lastTime) {
                recordTime = lastTime + 1;
            }
            lastTime = recordTime;

            chartPoints.push({
                time: recordTime,
                value: parseFloat(currentPnL.toFixed(2))
            });
        });

        this.equityLineSeries.setData(chartPoints);

        // 更新收益頁面的大字卡數據 (總收益與已實現交易筆數)
        const totalPnlEl = document.getElementById('equity-stat-total-pnl');
        const countEl = document.getElementById('equity-stat-count');
        if (totalPnlEl) {
            const sign = currentPnL >= 0 ? '+' : '';
            totalPnlEl.innerText = `${sign}${currentPnL.toFixed(2)} R`;
            totalPnlEl.style.color = currentPnL >= 0 ? 'var(--green)' : 'var(--red)';
        }
        if (countEl) {
            countEl.innerText = `${settledRecords.length} 筆`;
        }
    }

    async checkHistorySettlement() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            return;
        }

        const pendingRecords = history.filter(r => r.status === 'PENDING');
        if (pendingRecords.length === 0) return;

        let hasUpdates = false;

        // 一次最多查詢最近 5 筆 PENDING 紀錄的結算狀態，避免 Rate Limit
        const maxQueries = Math.min(pendingRecords.length, 5);
        for (let i = 0; i < maxQueries; i++) {
            const record = pendingRecords[i];
            try {
                // 根據時間週期，計算一根 K 線的毫秒數，並往前退 1 根 K 線作為查詢起點
                // 這樣能保證幣安 API 一定會回傳包含當前 K 線在內的數據，而不會回傳空陣列 []
                let intervalMs = 60 * 1000;
                if (record.interval === '5m') intervalMs = 5 * 60 * 1000;
                else if (record.interval === '15m') intervalMs = 15 * 60 * 1000;
                else if (record.interval === '1h') intervalMs = 60 * 60 * 1000;
                else if (record.interval === '4h') intervalMs = 4 * 60 * 60 * 1000;
                else if (record.interval === '1d') intervalMs = 24 * 60 * 60 * 1000;

                const queryStartTime = record.id - intervalMs;
                const url = `https://api.binance.com/api/v3/klines?symbol=${record.symbol}&interval=${record.interval}&startTime=${queryStartTime}&limit=500`;
                const response = await fetch(url);
                const klines = await response.json();

                if (!Array.isArray(klines) || klines.length === 0) continue;

                // 取得當前最新價格與自進場點以來的漲跌幅
                const currentPrice = parseFloat(klines[klines.length - 1][4]);
                const percentChange = ((currentPrice - record.entry) / record.entry) * 100;
                
                if (record.currentPrice !== currentPrice || record.percentChange !== percentChange) {
                    record.currentPrice = currentPrice;
                    record.percentChange = percentChange;
                    hasUpdates = true;
                }

                // 遍歷 K 線進行結算檢測，必須是時間在 record.id 之後的 K 線才進行判定，以防誤觸訊號產生前的 TP/SL
                for (let k = 0; k < klines.length; k++) {
                    const klineOpenTime = klines[k][0];
                    // 如果這根 K 線的開盤時間 + 週期毫秒小於等於訊號產生時間，代表這根是訊號之前的歷史 K 線，跳過
                    if (klineOpenTime + intervalMs < record.id) continue;

                    const high = parseFloat(klines[k][2]);
                    const low = parseFloat(klines[k][3]);

                    const cleanSymbol = record.symbol.replace('USDT', '');
                    if (record.type === 'LONG') {
                        if (low <= record.sl) {
                            record.status = 'SL';
                            hasUpdates = true;
                            this.showNotification(
                                `❌ 交易已止損 (Stop Loss)`,
                                `${cleanSymbol} LONG 交易進場於 $${this.formatPrice(record.entry)}，已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            break;
                        }
                        if (high >= record.tp) {
                            record.status = 'TP';
                            hasUpdates = true;
                            this.showNotification(
                                `🎯 交易已止盈 (Take Profit)`,
                                `${cleanSymbol} LONG 交易進場於 $${this.formatPrice(record.entry)}，已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            break;
                        }
                    } else if (record.type === 'SHORT') {
                        if (high >= record.sl) {
                            record.status = 'SL';
                            hasUpdates = true;
                            this.showNotification(
                                `❌ 交易已止損 (Stop Loss)`,
                                `${cleanSymbol} SHORT 交易進場於 $${this.formatPrice(record.entry)}，已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            break;
                        }
                        if (low <= record.tp) {
                            record.status = 'TP';
                            hasUpdates = true;
                            this.showNotification(
                                `🎯 交易已止盈 (Take Profit)`,
                                `${cleanSymbol} SHORT 交易進場於 $${this.formatPrice(record.entry)}，已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            break;
                        }
                    }
                }

                if (record.status === 'PENDING' && klines.length >= 500) {
                    record.status = 'EXPIRED';
                    hasUpdates = true;
                }

            } catch (err) {
                console.error(`Check settlement error for ${record.symbol}:`, err);
            }
        }

        if (hasUpdates) {
            localStorage.setItem(historyKey, JSON.stringify(history));
            this.renderHistory(false);
            this.syncToCloud(); // 結算狀態更新後，異步同步至雲端
        }
    }

    initFirebase() {
        if (typeof firebase !== 'undefined') {
            const firebaseConfig = {
                apiKey: "AIzaSyA6OdpBxjahvJXZl8WtlbwpC1uL9F_ij5w",
                authDomain: "crypto-6536b.firebaseapp.com",
                projectId: "crypto-6536b",
                storageBucket: "crypto-6536b.firebasestorage.app",
                messagingSenderId: "276295758545",
                appId: "1:276295758545:web:d2caac9ccefb618bae8bf0",
                databaseURL: "https://crypto-6536b-default-rtdb.firebaseio.com"
            };
            firebase.initializeApp(firebaseConfig);
            this.db = firebase.database();
        }
    }

    async syncToCloud() {
        if (!this.db || !this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        const configKey = `snr_email_config_${email}`;
        
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        let emailConfig = {};
        try {
            emailConfig = JSON.parse(localStorage.getItem(configKey) || '{}');
        } catch (e) {
            emailConfig = {};
        }

        try {
            // Realtime Database 鍵值不允許有點 (.)，將其替換為底線 (_)
            const safeEmail = email.replace(/\./g, '_');
            await this.db.ref('users/' + safeEmail).update({
                lastSymbol: this.symbol,
                lastInterval: this.interval,
                history: history,
                emailConfig: emailConfig,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        } catch (e) {
            console.error("Firebase sync save error:", e);
        }
    }

    initEmailJS() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_email_config_${email}`;
        let config = {};
        try {
            config = JSON.parse(localStorage.getItem(configKey) || '{}');
        } catch (e) {
            config = {};
        }

        const emailTarget = document.getElementById('email-target');
        const serviceId = document.getElementById('emailjs-service-id');
        const templateId = document.getElementById('emailjs-template-id');
        const publicKey = document.getElementById('emailjs-public-key');

        if (emailTarget) emailTarget.value = config.emailTarget || '';
        if (serviceId) serviceId.value = config.serviceId || '';
        if (templateId) templateId.value = config.templateId || '';
        if (publicKey) publicKey.value = config.publicKey || '';

        if (config.publicKey && typeof emailjs !== 'undefined') {
            emailjs.init(config.publicKey);
        }
    }

    toggleEmailConfig() {
        const content = document.getElementById('email-config-content');
        const arrow = document.getElementById('email-config-arrow');
        if (content && arrow) {
            content.classList.toggle('hidden');
            if (content.classList.contains('hidden')) {
                arrow.style.transform = 'rotate(0deg)';
            } else {
                arrow.style.transform = 'rotate(180deg)';
            }
        }
    }

    saveEmailConfig() {
        if (!this.currentUser) {
            alert('請先登入帳戶再儲存設定');
            return;
        }

        const emailTarget = document.getElementById('email-target').value.trim();
        const serviceId = document.getElementById('emailjs-service-id').value.trim();
        const templateId = document.getElementById('emailjs-template-id').value.trim();
        const publicKey = document.getElementById('emailjs-public-key').value.trim();

        if (!emailTarget) {
            alert('請填寫收信電子信箱');
            return;
        }

        const email = this.currentUser.email;
        const configKey = `snr_email_config_${email}`;
        
        const config = {
            emailTarget,
            serviceId,
            templateId,
            publicKey
        };

        localStorage.setItem(configKey, JSON.stringify(config));

        if (publicKey && typeof emailjs !== 'undefined') {
            emailjs.init(publicKey);
        }

        alert('信箱通知設定儲存成功！並已同步至雲端。');
        this.syncToCloud();
    }

    async sendTestEmail() {
        if (!this.currentUser) {
            alert('請先登入帳戶再測試發信');
            return;
        }

        const emailTarget = document.getElementById('email-target').value.trim();
        const serviceId = document.getElementById('emailjs-service-id').value.trim();
        const templateId = document.getElementById('emailjs-template-id').value.trim();
        const publicKey = document.getElementById('emailjs-public-key').value.trim();

        if (!emailTarget || !serviceId || !templateId || !publicKey) {
            alert('請完整填寫收信信箱、Service ID、Template ID 與 Public Key 再進行測試。');
            return;
        }

        const testBtn = document.getElementById('test-email-btn');
        testBtn.innerText = '發送中...';
        testBtn.disabled = true;

        try {
            if (typeof emailjs !== 'undefined') {
                emailjs.init(publicKey);
                
                const templateParams = {
                    to_email: emailTarget,
                    subject: '【SNR TRACER】測試發送郵件通知',
                    message: `您好，這是一封來自 SNR TRACER 策略分析儀的測試信件。\n\n當前您的 EmailJS 設定正確無誤。當自動背景雷達監控到符合條件的優質交易機會時，您將會在此信箱收到通知。\n\n發送時間：${new Date().toLocaleString()}`
                };

                const response = await emailjs.send(serviceId, templateId, templateParams);
                if (response.status === 200) {
                    alert('測試郵件發送成功！請檢查您的信箱（若沒看到，請檢查垃圾郵件匣）。');
                } else {
                    alert(`測試郵件發送失敗，狀態碼: ${response.status}`);
                }
            } else {
                alert('EmailJS SDK 未載入成功，請重新整理網頁後重試。');
            }
        } catch (error) {
            console.error('EmailJS test mail failed:', error);
            alert(`測試發信失敗: ${error.text || error.message || error}`);
        } finally {
            testBtn.innerText = '測試發送郵件';
            testBtn.disabled = false;
        }
    }

    startAutoRadarScan() {
        if (this.autoScanTimer) {
            clearInterval(this.autoScanTimer);
        }

        const intervalMs = 20 * 60 * 1000;
        this.autoScanTimer = setInterval(() => {
            console.log('背景自動掃描雷達中...');
            this.scanMarket();
        }, intervalMs);
    }

    async sendEmailNotification(newOpps) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_email_config_${email}`;
        
        let config = {};
        try {
            config = JSON.parse(localStorage.getItem(configKey) || '{}');
        } catch (e) {
            return;
        }

        const { emailTarget, serviceId, templateId, publicKey } = config;
        
        // 如果設定不完整，靜默跳過發信，只在控制台輸出
        if (!emailTarget || !serviceId || !templateId || !publicKey) {
            console.log('信箱通知設定不完整，跳過郵件發送');
            return;
        }

        if (typeof emailjs === 'undefined') {
            console.warn('EmailJS SDK 未載入，無法發送郵件');
            return;
        }

        try {
            emailjs.init(publicKey);

            // 格式化新發現的機會清單
            let messageText = `親愛的 SNR TRACER 使用者，您好：\n\n系統剛剛於 ${new Date().toLocaleString()} 掃描出符合條件的高盈虧比 (R:R > 1.0) 交易機會！\n\n`;
            messageText += `雷達週期：${this.interval.toUpperCase()}\n\n`;
            messageText += `【新交易機會清單】:\n`;
            
            newOpps.forEach((opp, i) => {
                const cleanSym = opp.symbol.replace('USDT', '');
                const dir = opp.signal === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
                messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 盈虧比: ${opp.rr.toFixed(2)}\n`;
            });

            messageText += `\n請儘速前往 SNR TRACER 平台查看詳情與設定您的進出場防守點位！\n`;
            messageText += `連結：http://localhost:8000\n\n`;
            messageText += `*此信件為系統自動發送，請勿直接回覆。`;

            const templateParams = {
                to_email: emailTarget,
                subject: `⚠️【SNR TRACER】雷達掃描到 ${newOpps.length} 個優質交易機會！`,
                message: messageText
            };

            const response = await emailjs.send(serviceId, templateId, templateParams);
            if (response.status === 200) {
                console.log('交易機會 Email 郵件發送成功！');
            } else {
                console.warn('交易機會 Email 郵件發送失敗，狀態碼:', response.status);
            }
        } catch (error) {
            console.error('發送機會信件出錯:', error);
        }
    }
}



let app;
window.onload = () => {
    app = new SNRTracer();
};
