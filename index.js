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
        this.autoScanCountdownTimer = null; // 自動雷達掃描倒數計時器
        this.autoScanSecondsLeft = 0; // 距離下一次自動分析的剩餘秒數
        this.notifiedOpportunities = {}; // 記錄已通知過的交易機會，防重複發信
        this.modalChart = null; // 歷史複盤 Modal 圖表實例
        this.modalCandlestickSeries = null;
        this.modalPriceLines = [];
        this.tpPriceLine = null; // 儲存 Modal 的 TP 價格線實例
        this.slPriceLine = null; // 儲存 Modal 的 SL 價格線實例
        this.currentDragRecord = null; // 儲存當前點選的歷史紀錄資料
        this.isDraggingTP = false; // 是否正在拖曳 TP 線
        this.isDraggingSL = false; // 是否正在拖曳 SL 線
        this.backtestChart = null; // 回測資金曲線圖表
        this.backtestLineSeries = null; // 回測資金折線圖
        this.strategyConfig = { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
        this.customBlacklist = []; // 使用者自訂排除掃描幣種黑名單
        this.paperBalance = 10000.0;
        this.priceUpdateTimer = null; // 背景自動更新價格定時器

        this.init();
    }

    async init() {
        this.initFirebase(); // 初始化 Firebase
        this.initChart();
        this.initEquityChart(); // 初始化模擬收益曲線圖表
        this.initBacktestChart(); // 初始化歷史回測圖表
        this.bindEvents();
        this.initAuth();
        
        // 全域 Loader 安全防卡死機制 (2秒後強制解除非單幣頁面的加載遮罩)
        setTimeout(() => {
            const activeTab = document.querySelector('.tab-btn.active');
            const activeTabId = activeTab ? activeTab.dataset.tab : 'history-tab';
            if (activeTabId !== 'single-coin-tab') {
                this.showLoader(false);
            }
        }, 2000); // 啟動身份驗證流程
        this.requestNotificationPermission(); // 請求通知權限
        this.initTelegramConfig(); // 初始化 Telegram 設定
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
                if (input.includes('RLUSD') || input.includes('FDUSD') || input.includes('UUSDT') || input.includes('TRXUSDT')) {
                    alert('穩定幣（RLUSD / FDUSD）系統已設定跳過分析！');
                    return;
                }
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
                    if (input.includes('RLUSD') || input.includes('FDUSD') || input.includes('UUSDT') || input.includes('TRXUSDT')) {
                        alert('穩定幣（RLUSD / FDUSD）系統已設定跳過分析！');
                        return;
                    }
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
            clearHistoryBtn.addEventListener('click', async () => {
                if (this.currentUser) {
                    if (confirm('確定要清除所有歷史分析紀錄嗎？此動作無法復原。')) {
                        const email = this.currentUser.email;
                        localStorage.removeItem(`snr_history_${email}`);
                        this.renderHistory();
                        
                        // 精準清空雲端的 history 節點，防止合併同步時再次拉回
                        if (this.db) {
                            try {
                                const safeEmail = email.replace(/\./g, '_');
                                await this.db.ref(`users/${safeEmail}`).update({
                                    history: [],
                                    updatedAt: firebase.database.ServerValue.TIMESTAMP
                                });
                                console.log('已成功清空雲端資料庫歷史紀錄！');
                            } catch (e) {
                                console.error('清空雲端歷史紀錄失敗:', e);
                            }
                        }
                        this.updatePaperAccountUI();
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

        // 歷史紀錄篩選狀態選單監聽
        const filterStatusSelect = document.getElementById('history-filter-status');
        if (filterStatusSelect) {
            filterStatusSelect.addEventListener('change', () => {
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

        // 模擬收益頁面更新即時狀況按鈕監聽
        const refreshEquityBtn = document.getElementById('refresh-equity-btn');
        if (refreshEquityBtn) {
            refreshEquityBtn.addEventListener('click', async () => {
                refreshEquityBtn.innerText = '正在更新...';
                refreshEquityBtn.disabled = true;
                try {
                    await this.checkHistorySettlement();
                    this.updateEquityCurveTab();
                    this.updatePaperAccountUI();
                } catch (e) {
                    console.error(e);
                } finally {
                    refreshEquityBtn.innerText = '更新即時狀況';
                    refreshEquityBtn.disabled = false;
                }
            });
        }

        // 儲存 Telegram 設定按鈕監聽
        const saveTgConfigBtn = document.getElementById('save-tg-config-btn');
        if (saveTgConfigBtn) {
            saveTgConfigBtn.addEventListener('click', () => {
                this.saveTelegramConfig();
            });
        }

        // 測試 Telegram 發送按鈕監聽
        const testTgBtn = document.getElementById('test-tg-btn');
        if (testTgBtn) {
            testTgBtn.addEventListener('click', () => {
                this.sendTestTelegramNotification();
            });
        }

        // Telegram Token 顯示/隱藏切換監聽
        const toggleTgTokenVisibilityBtn = document.getElementById('toggle-tg-token-visibility-btn');
        if (toggleTgTokenVisibilityBtn) {
            toggleTgTokenVisibilityBtn.addEventListener('click', () => {
                const tokenInput = document.getElementById('telegram-token');
                if (tokenInput) {
                    if (tokenInput.type === 'password') {
                        tokenInput.type = 'text';
                        toggleTgTokenVisibilityBtn.innerText = '隱藏';
                    } else {
                        tokenInput.type = 'password';
                        toggleTgTokenVisibilityBtn.innerText = '顯示';
                    }
                }
            });
        }

        // 儲存策略參數設定按鈕監聽
        
        const blacklistHeader = document.querySelector('.blacklist-config-header');
        if (blacklistHeader) {
            blacklistHeader.addEventListener('click', () => this.toggleBlacklistConfig());
        }

        const saveStrategyConfigBtn = document.getElementById('save-strategy-config-btn');
        if (saveStrategyConfigBtn) {
            saveStrategyConfigBtn.addEventListener('click', () => {
                this.saveStrategyConfig();
            });
        }

        // 黑名單按鈕事件綁定
        const addBlacklistBtn = document.getElementById('add-blacklist-btn');
        if (addBlacklistBtn) {
            addBlacklistBtn.addEventListener('click', () => this.addBlacklistSymbol());
        }
        const saveBlacklistConfigBtn = document.getElementById('save-blacklist-config-btn');
        if (saveBlacklistConfigBtn) {
            saveBlacklistConfigBtn.addEventListener('click', () => this.saveBlacklistConfig());
        }
        const blacklistInput = document.getElementById('blacklist-input');
        if (blacklistInput) {
            blacklistInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addBlacklistSymbol();
                }
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
            modalChartContainer.style.touchAction = 'none'; // 防止手機上拖曳時網頁被滾動
            modalChartContainer.addEventListener('pointerdown', (e) => this.handleChartMouseDown(e));
            modalChartContainer.addEventListener('pointermove', (e) => this.handleChartMouseMove(e));
            window.addEventListener('pointerup', (e) => this.handleChartMouseUp(e));
        }

        // 歷史回測按鈕監聽
        const runBacktestBtn = document.getElementById('run-backtest-btn');
        if (runBacktestBtn) {
            runBacktestBtn.addEventListener('click', () => this.runHistoricalBacktest());
        }

        const runOptimizationBtn = document.getElementById('run-optimization-btn');
        if (runOptimizationBtn) {
            runOptimizationBtn.addEventListener('click', () => this.runBacktestOptimization());
        }

        const top50Toggle = document.getElementById('backtest-top50-toggle');
        if (top50Toggle) {
            top50Toggle.addEventListener('change', (e) => {
                const symbolInput = document.getElementById('backtest-symbol');
                if (symbolInput) {
                    if (e.target.checked) {
                        symbolInput.disabled = true;
                        symbolInput.value = '前50大成交量幣種';
                    } else {
                        symbolInput.disabled = false;
                        symbolInput.value = 'BTCUSDT';
                    }
                }
            });
        }

        // 匯出歷史分析紀錄 CSV
        const exportHistoryCsvBtn = document.getElementById('export-history-csv-btn');
        if (exportHistoryCsvBtn) {
            exportHistoryCsvBtn.addEventListener('click', () => this.exportHistoryCSV());
        }

        // 匯出歷史分析紀錄 PDF
        const exportHistoryPdfBtn = document.getElementById('export-history-pdf-btn');
        if (exportHistoryPdfBtn) {
            exportHistoryPdfBtn.addEventListener('click', () => this.exportHistoryPDF());
        }

        // 匯出回測結果 CSV
        const exportBacktestCsvBtn = document.getElementById('export-backtest-csv-btn');
        if (exportBacktestCsvBtn) {
            exportBacktestCsvBtn.addEventListener('click', () => this.exportBacktestCSV());
        }

        // 匯出回測結果 PDF
        const exportBacktestPdfBtn = document.getElementById('export-backtest-pdf-btn');
        if (exportBacktestPdfBtn) {
            exportBacktestPdfBtn.addEventListener('click', () => this.exportBacktestPDF());
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
        
        if (tabId === 'market-radar-tab' || tabId === 'history-tab' || tabId === 'equity-curve-tab' || tabId === 'backtest-tab') {
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
            this.updatePaperAccountUI();
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

        // 切換到回測 Tab 時，自適應圖表大小
        if (tabId === 'backtest-tab') {
            this.initBacktestChart();
            setTimeout(() => {
                const chartElement = document.getElementById('backtest-equity-chart');
                if (this.backtestChart && chartElement) {
                    this.backtestChart.applyOptions({
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
                
                // 加上 2.5 秒超時機制，防止斷網或連線卡住時網頁 Loader 永久無法關閉
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Firebase sync timeout')), 2500)
                );
                const snapshot = await Promise.race([dbRef.once('value'), timeoutPromise]);
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
                    if (cloudData.telegramConfig) {
                        localStorage.setItem(`snr_telegram_config_${user.email}`, JSON.stringify(cloudData.telegramConfig));
                    }
                    if (cloudData.strategyConfig) {
                        localStorage.setItem(`snr_strategy_config_${user.email}`, JSON.stringify(cloudData.strategyConfig));
                    }
                    if (cloudData.paperBalance !== undefined) {
                        localStorage.setItem(`snr_paper_balance_${user.email}`, cloudData.paperBalance);
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
        
        // 登入成功後載入自定義策略參數設定、虛擬帳戶與 LINE Notify 設定
        this.initStrategyConfig();
        this.initPaperAccount();
        this.initTelegramConfig();
        this.initBlacklistConfig();
        
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

        // 登入成功後啟動每 1 分鐘即時價格與持倉狀態自動更新
        this.startPriceAutoUpdateTimer();
    }

    async fetchAndAnalyze(isInitial = false) {
        if (this.symbol && (this.symbol.toUpperCase().includes('RLUSD') || this.symbol.toUpperCase().includes('FDUSD') || this.symbol.toUpperCase().includes('UUSDT') || this.symbol.toUpperCase().includes('TRXUSDT'))) {
            alert('穩定幣（RLUSD / FDUSD）系統已設定跳過分析！');
            this.showLoader(false);
            return;
        }

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
                        analysis.rr,
                        analysis.winRate
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

    async getBinanceData(symbol, interval, limit = 150) {
        const cleanSymbol = symbol.toUpperCase().replace('/', '');
        let allKlines = [];
        let lastEndTime = null;

        while (allKlines.length < limit) {
            const fetchLimit = Math.min(limit - allKlines.length, 1000);
            if (fetchLimit <= 0) break;

            let url = `https://data-api.binance.vision/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${fetchLimit}`;
            if (lastEndTime !== null) {
                url += `&endTime=${lastEndTime}`;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            let response;
            try {
                response = await fetch(url, { signal: controller.signal });
            } catch (e) {
                if (e.name === 'AbortError') {
                    throw new Error('幣安 API 連線逾時，請檢查網路狀態！');
                }
                throw e;
            } finally {
                clearTimeout(timeoutId);
            }
            if (!response.ok) throw new Error('Binance API response not ok');
            const data = await response.json();
            if (!data || data.length === 0) break;

            const formatted = data.map(d => ({
                openTime: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5]
            }));

            allKlines = [...formatted, ...allKlines];

            // 準備下一次往前抓取的 endTime
            lastEndTime = formatted[0].openTime - 1;

            if (data.length < fetchLimit) {
                break;
            }
        }

        return allKlines;
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

    calculateRSI(data, period = 14) {
        const rsi = new Array(data.length).fill(null);
        if (data.length <= period) return rsi;

        let avgGain = 0;
        let avgLoss = 0;

        for (let i = 1; i <= period; i++) {
            const change = data[i].close - data[i - 1].close;
            if (change > 0) {
                avgGain += change;
            } else {
                avgLoss += Math.abs(change);
            }
        }

        avgGain /= period;
        avgLoss /= period;

        rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

        for (let i = period + 1; i < data.length; i++) {
            const change = data[i].close - data[i - 1].close;
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;

            rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
        }

        return rsi;
    }

    calculateMACD(data) {
        const ema12 = this.calculateEMA(data, 12);
        const ema26 = this.calculateEMA(data, 26);
        
        const macdLine = new Array(data.length).fill(null);
        for (let i = 0; i < data.length; i++) {
            if (ema12[i] !== null && ema26[i] !== null) {
                macdLine[i] = ema12[i] - ema26[i];
            }
        }
        
        const signalLine = new Array(data.length).fill(null);
        let firstValidIdx = -1;
        for (let i = 0; i < data.length; i++) {
            if (macdLine[i] !== null) {
                firstValidIdx = i;
                break;
            }
        }
        
        if (firstValidIdx === -1 || data.length < firstValidIdx + 9) {
            return { macd: macdLine, signal: signalLine, hist: new Array(data.length).fill(null) };
        }
        
        let sum = 0;
        for (let i = 0; i < 9; i++) {
            sum += macdLine[firstValidIdx + i];
        }
        let signalEMA = sum / 9;
        signalLine[firstValidIdx + 8] = signalEMA;
        
        const multiplier = 2 / (9 + 1);
        for (let i = firstValidIdx + 9; i < data.length; i++) {
            signalEMA = (macdLine[i] - signalEMA) * multiplier + signalEMA;
            signalLine[i] = signalEMA;
        }
        
        const hist = new Array(data.length).fill(null);
        for (let i = 0; i < data.length; i++) {
            if (macdLine[i] !== null && signalLine[i] !== null) {
                hist[i] = macdLine[i] - signalLine[i];
            }
        }
        
        return { macd: macdLine, signal: signalLine, hist };
    }

    // 核心 SNR 運算邏輯 (整合 EMA 趨勢、ATR 波動度、RSI與MACD多指標共振)
    analyzeSNR(data, config = null) {
        const activeConfig = config || this.strategyConfig || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30 };
        const emaPeriod = activeConfig.emaPeriod || 50;
        const atrMultiplier = activeConfig.atrMultiplier || 1.5;

        const lastPrice = data[data.length - 1].close;
        const emaVal = this.calculateEMA(data, emaPeriod);
        const lastEMA = emaVal[emaVal.length - 1];
        const prevEMA = emaVal[emaVal.length - 2];
        const lastATR = this.calculateLastATR(data, 14);

        // 多指標共振計算
        const rsiVal = this.calculateRSI(data, 14);
        const lastRSI = rsiVal[rsiVal.length - 1];
        const macdVal = this.calculateMACD(data);
        const lastHist = macdVal.hist[macdVal.hist.length - 1];
        const prevHist = macdVal.hist[macdVal.hist.length - 2];

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
        const triggerDist = lastATR > 0 ? lastATR * atrMultiplier : lastPrice * (atrMultiplier * 0.01);
        
        // 動態止損緩衝 (ATR-based)
        const slBuffer = lastATR > 0 ? lastATR * atrMultiplier : lastPrice * (atrMultiplier * 0.01);

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

        // 確保止盈方向正確且盈虧比為正值，防範支撐壓力重疊造成的異常信號
        if (signal === 'LONG') {
            if (tp <= lastPrice || rr <= 0) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        } else if (signal === 'SHORT') {
            if (tp >= lastPrice || rr <= 0) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
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

        // === 多指標共振過濾 (RSI超買超賣過濾) ===
        if (signal === 'LONG' && lastRSI !== null && lastRSI > 65) {
            // 已超買，避免在支撐位追漲殺跌，過濾信號
            signal = 'WATCH';
            rr = 0;
            sl = 0;
            tp = 0;
        } else if (signal === 'SHORT' && lastRSI !== null && lastRSI < 35) {
            // 已超賣，避免在阻力位追跌殺漲，過濾信號
            signal = 'WATCH';
            rr = 0;
            sl = 0;
            tp = 0;
        }

        // === 計算綜合勝率評估分數 (winRate) ===
        let winRate = 0.50; // 基礎勝率 50%
        if (signal !== 'WATCH') {
            // 1. 支撐/壓力強度加分 (Level Strength)
            const level = signal === 'LONG' ? support : resistance;
            if (level && level.count) {
                const strengthAdd = Math.min((level.count - 2) * 0.02, 0.08);
                winRate += strengthAdd;
            }

            // 2. 順勢度加分 (Trend Alignment)
            const isEMAUprising = lastEMA > prevEMA;
            const isEMADeclining = lastEMA < prevEMA;
            
            if (signal === 'LONG') {
                if (lastPrice > lastEMA && isEMAUprising) {
                    winRate += 0.08;
                } else if (lastPrice < lastEMA && isEMAUprising) {
                    winRate += 0.02;
                }
            } else if (signal === 'SHORT') {
                if (lastPrice < lastEMA && isEMADeclining) {
                    winRate += 0.08;
                } else if (lastPrice > lastEMA && isEMADeclining) {
                    winRate += 0.02;
                }
            }

            // 3. 進場點精確度加分 (Entry Precision)
            const levelVal = signal === 'LONG' ? support.value : resistance.value;
            const distToLevel = Math.abs(lastPrice - levelVal);
            if (lastATR > 0) {
                const distRatio = distToLevel / lastATR;
                const precisionAdd = Math.min(Math.max((atrMultiplier - distRatio) * 0.04, -0.02), 0.06);
                winRate += precisionAdd;
            }

            // 4. RSI 共振加分
            if (signal === 'LONG' && lastRSI !== null && lastRSI < 40) {
                winRate += 0.08; // 超跌回檔區做多，勝率提升
            } else if (signal === 'SHORT' && lastRSI !== null && lastRSI > 60) {
                winRate += 0.08; // 超漲反彈區做空，勝率提升
            }

            // 5. MACD 動能共振加減分
            if (lastHist !== null && prevHist !== null) {
                if (signal === 'LONG') {
                    if (lastHist > 0 || lastHist > prevHist) {
                        winRate += 0.05; // 多頭動能增強，加分
                    } else if (lastHist < 0 && lastHist < prevHist) {
                        winRate -= 0.05; // 仍在急跌段，扣分
                    }
                } else if (signal === 'SHORT') {
                    if (lastHist < 0 || lastHist < prevHist) {
                        winRate += 0.05; // 空頭動能增強，加分
                    } else if (lastHist > 0 && lastHist > prevHist) {
                        winRate -= 0.05; // 仍在急漲段，扣分
                    }
                }
            }
        } else {
            winRate = 0.0;
        }
        
        // 限制最終勝率在 35% ~ 75% 之間
        winRate = Math.min(Math.max(winRate, 0.35), 0.75);

        return { levels, support, resistance, signal, rr, sl, tp, lastATR, winRate, rsi: lastRSI, macdHist: lastHist };
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
            // 先獲取當前歷史紀錄以供重複交易與盈虧比判定
            const email = this.currentUser ? this.currentUser.email : 'guest';
            const historyKey = `snr_history_${email}`;
            let history = [];
            try {
                history = JSON.parse(localStorage.getItem(historyKey) || '[]');
            } catch (e) {
                history = [];
            }

            // 1. 獲取成交量前 50 大 USDT 交易對
            const tickerUrl = 'https://data-api.binance.vision/api/v3/ticker/24hr';
            const tickers = await (await fetch(tickerUrl)).json();
            const top50 = tickers
                .filter(t => t.symbol.endsWith('USDT') && !t.symbol.startsWith('RLUSD') && !t.symbol.startsWith('FDUSD') && t.symbol !== 'UUSDT' && t.symbol !== 'TRXUSDT')
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
                            sl: analysis.sl,
                            lastPrice: lastPrice,
                            winRate: analysis.winRate
                        });
                    }
                } catch (e) {
                    console.warn(`Skip ${item.symbol} due to error`);
                }
            }

            // 3. 去重篩選與重複交易判定 (比照 radar_scan.js 雲端自動掃描機制)
            const now = Date.now();
            const newOpportunities = [];
            const savedOpportunities = [];

            opportunities.forEach(opp => {
                // 尋找是否存在同幣種的 PENDING 舊交易 (不限時間週期)
                const oldPendingIndex = history.findIndex(r => 
                    r.symbol === opp.symbol && 
                    r.status === 'PENDING'
                );

                if (oldPendingIndex !== -1) {
                    const oldPending = history[oldPendingIndex];
                    const oldWinRate = oldPending.winRate !== undefined ? oldPending.winRate : 0.50;
                    const newWinRate = opp.winRate !== undefined ? opp.winRate : 0.50;
                    
                    if (newWinRate > oldWinRate) {
                        // 新機會較佳：標記替換、跳過時間去重限制，並記錄舊交易資訊
                        opp.replaceOld = true;
                        opp.oldWinRate = oldWinRate;
                        opp.oldId = oldPending.id;
                        opp.oldType = oldPending.type;
                        opp.oldEntry = oldPending.entry;
                        opp.oldInterval = oldPending.interval;
                        newOpportunities.push(opp);
                        savedOpportunities.push(opp);
                    } else {
                        // 舊交易較佳：維持舊交易，跳過新機會
                        console.log(`[${opp.symbol}] 舊交易 PENDING (${oldPending.interval.toUpperCase()}) 的 winRate (${(oldWinRate * 100).toFixed(0)}%) 優於或等於新機會 (${(newWinRate * 100).toFixed(0)}%)，維持舊交易。`);
                    }
                } else {
                    // 沒有同幣種同週期的 Pending 舊交易，維持原有 10 分鐘去重邏輯
                    const key = `${opp.symbol}_${this.interval}_${opp.signal}`;
                    const lastNotified = this.notifiedOpportunities[key];
                    
                    if (!lastNotified || (now - lastNotified) > 10 * 60 * 1000) {
                        newOpportunities.push(opp);
                        this.notifiedOpportunities[key] = now;
                    }
                    // 全新無重複的交易也需要保留並寫入
                    savedOpportunities.push(opp);
                }
            });

            // 4. 將篩選出的機會寫入歷史紀錄 (此時只存 localStorage，最後統一同步至雲端)
            savedOpportunities.forEach(opp => {
                this.saveToHistory(
                    opp.symbol,
                    this.interval,
                    opp.signal,
                    opp.lastPrice,
                    opp.tp,
                    opp.sl,
                    opp.rr,
                    opp.winRate
                );
            });

            // 5. 發送通知與顯示
            if (newOpportunities.length > 0) {
                // 1. 發送 Telegram 通知
                this.sendTelegramNotification(newOpportunities);
                
                // 2. 顯示系統桌面通知（內含提示音效）
                if (newOpportunities.length === 1) {
                    const opp = newOpportunities[0];
                    const cleanSym = opp.symbol.replace('USDT', '');
                    const dir = opp.signal === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
                    const extraMsg = opp.replaceOld ? ' (🔄 已自動平倉替換舊交易)' : '';
                    this.showNotification(
                        `📬 發現新交易機會！${extraMsg}`,
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
            if (savedOpportunities.length > 0) {
                this.syncToCloud();
            }

            // 6. 更新 UI 列表
            radarCount.innerText = `${savedOpportunities.length} 標的`;
            radarStatus.innerText = '掃描完成';
            
            if (savedOpportunities.length === 0) {
                radarList.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 40px; color: var(--text-muted);">目前無符合高盈虧比 (盈虧比 > 1) 的交易機會</td></tr>';
            } else {
                radarList.innerHTML = savedOpportunities
                    .sort((a, b) => b.rr - a.rr) // 按 RR 排序
                    .map(opp => {
                        const rrPercent = Math.min(opp.rr * 20, 100); // 將 RR 轉化為進度條百分比
                        const replaceLabel = opp.replaceOld 
                            ? `<span style="font-size: 11px; color: var(--accent-color); margin-left: 6px;" title="此機會之盈虧比優於您進行中的舊交易，系統已自動將舊交易平倉並替換！">🔄 替換</span>` 
                            : '';
                        return `
                            <tr>
                                <td>
                                    <span class="symbol-name">${opp.symbol.replace('USDT', '')}</span>
                                    <span style="color: var(--text-muted); font-size: 12px; margin-left: 5px;">/USDT</span>
                                    ${replaceLabel}
                                </td>
                                <td>
                                    <span class="signal-badge ${opp.signal === 'LONG' ? 'long' : 'short'}">
                                        ${opp.signal === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)'}
                                    </span>
                                    ${opp.winRate !== undefined ? `<div style="font-size: 10px; color: var(--text-muted); margin-top: 5px;">預估勝率: ${(opp.winRate * 100).toFixed(0)}%</div>` : ''}
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

    saveToHistory(symbol, interval, type, entry, tp, sl, rr, winRate) {
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
        let recordId = now;
        while (history.some(r => r.id === recordId)) {
            recordId++;
        }

        // 尋找是否存在同幣種的 PENDING 舊交易 (不限時間週期)
        const oldPendingIndex = history.findIndex(r => 
            r.symbol === symbol && 
            r.status === 'PENDING'
        );

        let replaceOld = false;
        if (oldPendingIndex !== -1) {
            const oldPending = history[oldPendingIndex];
            const oldWinRate = oldPending.winRate !== undefined ? oldPending.winRate : 0.50;
            const newWinRate = winRate !== undefined ? winRate : 0.50;

            if (newWinRate > oldWinRate) {
                // 新的勝率較佳，將舊交易改為 CLOSED，並記錄平倉價格，允許寫入新交易
                oldPending.status = 'CLOSED';
                oldPending.closePrice = entry; // 平倉價即為當前現價（新機會進場點）
                replaceOld = true;
            } else {
                // 舊的勝率較佳，跳過新機會
                console.log(`[${symbol}] 舊交易 PENDING (${oldPending.interval.toUpperCase()}) 的 winRate (${(oldWinRate * 100).toFixed(0)}%) 優於或等於新機會 (${(newWinRate * 100).toFixed(0)}%)，維持舊交易。`);
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

        // 計算模擬倉位資訊
        const slPercent = (Math.abs(entry - sl) / entry) * 100;
        const riskRatio = this.strategyConfig.riskRatio || 30;
        const paperLeverage = riskRatio / slPercent;
        const paperMargin = this.paperBalance * 0.02 / (riskRatio / 100);
        const paperPositionValue = paperMargin * paperLeverage;

        const date = new Date(now);
        const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

        const newRecord = {
            id: recordId,
            timeStr: timeStr,
            symbol: symbol,
            interval: interval,
            type: type,
            entry: entry,
            tp: tp,
            sl: sl,
            rr: rr,
            winRate: winRate !== undefined ? winRate : 0.50,
            status: 'PENDING',
            
            // 模擬交易持倉數據快照
            paperBalanceAtOpen: this.paperBalance,
            slPercent: slPercent,
            leverage: paperLeverage,
            margin: paperMargin,
            positionValue: paperPositionValue,
            feeRate: this.strategyConfig.feeRate !== undefined ? this.strategyConfig.feeRate : 0.05,
            slippage: this.strategyConfig.slippage !== undefined ? this.strategyConfig.slippage : 0.02
        };

        // 如果是替換舊交易，先為舊交易進行餘額盈虧結算
        if (replaceOld && oldPendingIndex !== -1) {
            const oldPending = history[oldPendingIndex];
            if (!oldPending.settledBalance) {
                const oldInitialSl = oldPending.initialSl !== undefined ? oldPending.initialSl : oldPending.sl;
                const oldRisk = Math.abs(oldPending.entry - oldInitialSl);
                const pnlR = oldRisk > 0 ? (oldPending.type === 'LONG'
                    ? (entry - oldPending.entry) / oldRisk
                    : (oldPending.entry - entry) / oldRisk) : 0.0;
                
                oldPending.pnlR = pnlR;
                this.settlePaperTrade(oldPending, 'CLOSED');
            }
        }

        history.unshift(newRecord);

        // 限制只保留最近 100 筆，超出部分刪除
        if (history.length > 100) {
            history = history.slice(0, 100);
        }

        localStorage.setItem(historyKey, JSON.stringify(history));
        this.updatePaperAccountUI();
        this.syncToCloud();
    }

    renderHistory(shouldCheck = true) {
        if (!this.currentUser) return;
        this.updatePaperAccountUI();
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 取得篩選方向、週期與狀態設定
        const filterDirSelect = document.getElementById('history-filter-direction');
        const selectedDir = filterDirSelect ? filterDirSelect.value : 'ALL';
        
        const filterIntervalSelect = document.getElementById('history-filter-interval');
        const selectedInterval = filterIntervalSelect ? filterIntervalSelect.value : 'ALL';

        const filterStatusSelect = document.getElementById('history-filter-status');
        const selectedStatus = filterStatusSelect ? filterStatusSelect.value : 'ALL';
        
        let filteredHistory = history;
        if (selectedDir !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.type === selectedDir);
        }
        if (selectedInterval !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.interval === selectedInterval);
        }
        if (selectedStatus !== 'ALL') {
            filteredHistory = filteredHistory.filter(r => r.status === selectedStatus);
        }

        const total = filteredHistory.length;
        const settled = filteredHistory.filter(r => r.status === 'TP' || r.status === 'SL' || r.status === 'CLOSED');
        
        let winCount = 0;
        let lossCount = 0;
        
        settled.forEach(r => {
            if (r.status === 'TP') {
                winCount++;
            } else if (r.status === 'SL') {
                lossCount++;
            } else if (r.status === 'CLOSED') {
                if (r.closePrice !== undefined && r.closePrice !== null) {
                    const risk = Math.abs(r.entry - r.sl);
                    let pnlChange = 0.0;
                    if (risk > 0) {
                        pnlChange = r.type === 'LONG' 
                            ? (r.closePrice - r.entry) / risk 
                            : (r.entry - r.closePrice) / risk;
                    }
                    if (pnlChange > 0) {
                        winCount++;
                    } else {
                        lossCount++;
                    }
                } else {
                    lossCount++;
                }
            }
        });
        
        const winRate = settled.length > 0 ? `${((winCount / settled.length) * 100).toFixed(1)}%` : '--';

        document.getElementById('history-stat-total').innerText = `${total} 筆`;
        document.getElementById('history-stat-settled').innerText = `${settled.length} 筆`;
        document.getElementById('history-stat-winrate').innerText = winRate;
        document.getElementById('history-stat-ratio').innerText = `${winCount} / ${lossCount}`;

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
                    
                    // 計算模擬交易的未實現盈虧
                    let paperPnLHTML = '';
                    if (r.paperBalanceAtOpen !== undefined && r.slPercent !== undefined) {
                        const initialSl = r.initialSl !== undefined ? r.initialSl : r.sl;
                        const risk = Math.abs(r.entry - initialSl);
                        const pnlR = risk > 0 ? (r.type === 'LONG'
                            ? (r.currentPrice - r.entry) / risk
                            : (r.entry - r.currentPrice) / risk) : 0.0;
                        const unrealProfit = r.paperBalanceAtOpen * 0.02 * pnlR;
                        const unrealStr = unrealProfit >= 0 ? `+$${unrealProfit.toFixed(2)}` : `-$${Math.abs(unrealProfit).toFixed(2)}`;
                        const unrealClass = unrealProfit >= 0 ? 'text-green' : 'text-red';
                        paperPnLHTML = `未實現: <span class="${unrealClass}" style="font-weight: 700;">${unrealStr}</span><br>`;
                    }

                    statusHTML = `
                        <span class="status-pill pending">進行中 ⏳</span>
                        <div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">
                            現價: $${this.formatPrice(r.currentPrice)}<br>
                            漲跌: <span class="${percentClass}" style="font-weight: 700;">${percentStr}</span><br>
                            ${paperPnLHTML}
                        </div>
                    `;
                } else {
                    statusHTML = `<span class="status-pill pending">進行中 ⏳</span>`;
                }
            } else if (r.status === 'TP') {
                const profit = r.realizedProfit !== undefined ? r.realizedProfit : ((r.paperBalanceAtOpen || 10000) * 0.02 * (r.rr || 1.5));
                let frictionHTML = '';
                if (r.frictionCost !== undefined && r.frictionCost !== null && typeof r.frictionCost === 'number') {
                    frictionHTML = `<br>摩擦: <span style="color: var(--text-muted); font-size: 10px;">${r.frictionCost.toFixed(2)} USDT</span>`;
                }
                const profitHTML = `<div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">收益: <span class="text-green" style="font-weight: 700;">+${profit.toFixed(2)}</span>${frictionHTML}</div>`;
                statusHTML = `
                    <span class="status-pill tp">已止盈 🎯</span>
                    ${profitHTML}
                `;
            } else if (r.status === 'SL') {
                const profit = r.realizedProfit !== undefined ? r.realizedProfit : -((r.paperBalanceAtOpen || 10000) * 0.02);
                let frictionHTML = '';
                if (r.frictionCost !== undefined && r.frictionCost !== null && typeof r.frictionCost === 'number') {
                    frictionHTML = `<br>摩擦: <span style="color: var(--text-muted); font-size: 10px;">${r.frictionCost.toFixed(2)} USDT</span>`;
                }
                const profitHTML = `<div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">收益: <span class="text-red" style="font-weight: 700;">-${Math.abs(profit).toFixed(2)}</span>${frictionHTML}</div>`;
                statusHTML = `
                    <span class="status-pill sl">已止損 ❌</span>
                    ${profitHTML}
                `;
            } else if (r.status === 'CLOSED') {
                if (r.closePrice !== undefined && r.closePrice !== null) {
                    const risk = Math.abs(r.entry - r.sl);
                    let pnlChange = 0.0;
                    if (risk > 0) {
                        pnlChange = r.type === 'LONG' 
                            ? (r.closePrice - r.entry) / risk 
                            : (r.entry - r.closePrice) / risk;
                    }
                    const pnlStr = pnlChange >= 0 ? `+${pnlChange.toFixed(2)} R` : `${pnlChange.toFixed(2)} R`;
                    const pnlClass = pnlChange >= 0 ? 'text-green' : 'text-red';
                    
                    const profit = r.realizedProfit !== undefined ? r.realizedProfit : ((r.paperBalanceAtOpen || 10000) * 0.02 * pnlChange);
                    const profitStr = profit >= 0 ? `+${profit.toFixed(2)}` : `-${Math.abs(profit).toFixed(2)}`;
                    let frictionHTML = '';
                    if (r.frictionCost !== undefined && r.frictionCost !== null && typeof r.frictionCost === 'number') {
                        frictionHTML = `<br>摩擦: <span style="color: var(--text-muted); font-size: 10px;">${r.frictionCost.toFixed(2)} USDT</span>`;
                    }
                    const profitHTML = `金額: <span class="${pnlClass}" style="font-weight: 700;">${profitStr}</span>${frictionHTML}<br>`;

                    statusHTML = `
                        <span class="status-pill closed">已平倉 🔄</span>
                        <div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">
                            平倉價: ${this.formatPrice(r.closePrice)}<br>
                            收益: <span class="${pnlClass}" style="font-weight: 700;">${pnlStr}</span><br>
                            ${profitHTML}
                        </div>
                    `;
                } else {
                    const profit = r.realizedProfit !== undefined ? r.realizedProfit : -((r.paperBalanceAtOpen || 10000) * 0.02);
                    let frictionHTML = '';
                    if (r.frictionCost !== undefined && r.frictionCost !== null && typeof r.frictionCost === 'number') {
                        frictionHTML = `<br>摩擦: <span style="color: var(--text-muted); font-size: 10px;">${r.frictionCost.toFixed(2)} USDT</span>`;
                    }
                    statusHTML = `
                        <span class="status-pill closed">已平倉 🔄</span>
                        <div style="font-size: 11px; margin-top: 6px; color: var(--text-muted); line-height: 1.4;">
                            收益: <span class="text-red" style="font-weight: 700;">-1.00 R</span><br>
                            金額: <span class="text-red" style="font-weight: 700;">-${Math.abs(profit).toFixed(2)}</span>${frictionHTML}
                        </div>
                    `;
                }
            } else {
                statusHTML = `<span class="status-pill expired">已過期 ⏳</span>`;
            }

            // 計算建議槓桿倍數 (自定義預期虧損)
            const riskRatio = (this.strategyConfig && this.strategyConfig.riskRatio) ? this.strategyConfig.riskRatio : 30;
            const slPercent = (Math.abs(r.entry - r.sl) / r.entry) * 100;
            let leverageHTML = '--';
            if (slPercent > 0) {
                const leverage = riskRatio / slPercent;
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
                        ${(r.rr !== undefined && r.rr !== null) ? (typeof r.rr === 'number' ? r.rr.toFixed(2) : parseFloat(r.rr).toFixed(2)) : '--'}
                        ${r.winRate !== undefined ? `<div style="font-size: 10px; color: var(--text-muted); font-weight: normal; margin-top: 3px;">勝率: ${(r.winRate * 100).toFixed(0)}%</div>` : ''}
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

    async deleteHistoryRecord(id) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let localHistory = [];
        try {
            localHistory = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            localHistory = [];
        }

        const recordIndex = localHistory.findIndex(r => r.id === id);
        if (recordIndex === -1) return;

        const record = localHistory[recordIndex];
        if (!confirm(`確定要刪除 ${record.symbol.replace('USDT', '')} (${record.interval.toUpperCase()}) 的這筆歷史分析紀錄嗎？`)) {
            return;
        }

        // 1. 本地先移除並更新 UI
        localHistory.splice(recordIndex, 1);
        localStorage.setItem(historyKey, JSON.stringify(localHistory));
        this.renderHistory(false);
        this.updatePaperAccountUI();

        // 2. 精準從 Firebase 中讀取、移除並寫回，防止 mergeHistory 把它重新拉回來
        if (this.db) {
            try {
                const safeEmail = email.replace(/\./g, '_');
                const dbRef = this.db.ref(`users/${safeEmail}`);
                
                // 讀取最新的雲端歷史紀錄
                const snapshot = await dbRef.once('value');
                if (snapshot.exists()) {
                    const cloudData = snapshot.val();
                    let cloudHistory = cloudData.history || [];
                if (cloudData.blacklistedSymbols && Array.isArray(cloudData.blacklistedSymbols)) {
                    this.customBlacklist = cloudData.blacklistedSymbols;
                    this.renderCustomBlacklistTags();
                }
                    
                    // 移除對應 id 的紀錄
                    cloudHistory = cloudHistory.filter(r => r.id !== id);
                    
                    // 寫回雲端
                    await dbRef.update({
                        history: cloudHistory,
                        updatedAt: firebase.database.ServerValue.TIMESTAMP
                    });
                    console.log(`已成功從雲端資料庫精準移除交易紀錄: ${id}`);
                }
            } catch (err) {
                console.error("精準移除雲端交易紀錄失敗:", err);
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

                const url = `https://data-api.binance.vision/api/v3/klines?symbol=${record.symbol}&interval=${record.interval}&startTime=${queryStartTime}&limit=1000`;
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
            let pnlChange = 0;
            if (r.status === 'TP') {
                pnlChange = r.rr;
            } else if (r.status === 'SL') {
                pnlChange = -1.0;
            } else if (r.status === 'CLOSED') {
                if (r.closePrice !== undefined && r.closePrice !== null) {
                    const risk = Math.abs(r.entry - r.sl);
                    if (risk > 0) {
                        pnlChange = r.type === 'LONG' 
                            ? (r.closePrice - r.entry) / risk 
                            : (r.entry - r.closePrice) / risk;
                    } else {
                        pnlChange = 0.0;
                    }
                } else {
                    pnlChange = -1.0; // 舊交易無平倉價數據時，保守估計為損失 1R
                }
            }
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

    // 初始化歷史回測資金圖表
    initBacktestChart() {
        if (this.backtestChart) return;
        const chartElement = document.getElementById('backtest-equity-chart');
        if (!chartElement) return;

        this.backtestChart = LightweightCharts.createChart(chartElement, {
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

        this.backtestLineSeries = this.backtestChart.addSeries(LightweightCharts.LineSeries, {
            color: '#f0b90b',
            lineWidth: 3,
            priceFormat: {
                type: 'price',
                precision: 2,
            }
        });

        window.addEventListener('resize', () => {
            if (this.backtestChart && chartElement) {
                this.backtestChart.applyOptions({
                    width: chartElement.clientWidth,
                    height: chartElement.clientHeight
                });
            }
        });
    }

    // 無副作用之單次策略回測計算，方便常規回測與參數最佳化網格搜尋複用
    evaluateStrategy(klines, symbol, config = null) {
        const activeConfig = config || this.strategyConfig || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
        const feeRate = activeConfig.feeRate !== undefined ? activeConfig.feeRate : 0.05;
        const slippage = activeConfig.slippage !== undefined ? activeConfig.slippage : 0.02;

        const getFriction = (trade) => {
            const slPercent = (Math.abs(trade.entry - trade.sl) / trade.entry) * 100;
            return slPercent > 0 ? (2 * (feeRate + slippage) / slPercent) : 0;
        };

        const trades = [];
        let activeTrade = null;

        for (let i = 100; i < klines.length; i++) {
            const currentK = klines[i];
            const historicalWindow = klines.slice(0, i + 1).map(d => ({
                time: d.openTime / 1000,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close
            }));

            const analysis = this.analyzeSNR(historicalWindow, config);

            if (activeTrade) {
                if (analysis.signal !== 'WATCH' && analysis.rr > 1.0) {
                    if (analysis.winRate > activeTrade.winRate) {
                        const closePrice = currentK.close;
                        const risk = Math.abs(activeTrade.entry - activeTrade.sl);
                        let pnl = 0;
                        if (risk > 0) {
                            pnl = activeTrade.direction === 'LONG'
                                ? (closePrice - activeTrade.entry) / risk
                                : (activeTrade.entry - closePrice) / risk;
                        }
                        
                        activeTrade.status = 'CLOSED';
                        activeTrade.closePrice = closePrice;
                        activeTrade.closeTime = currentK.openTime;
                        
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = pnl - frictionR;
                        
                        trades.push({ ...activeTrade });

                        activeTrade = {
                            symbol: symbol,
                            direction: analysis.signal,
                            entry: currentK.close,
                            tp: analysis.tp,
                            sl: analysis.sl,
                            rr: analysis.rr,
                            winRate: analysis.winRate,
                            openTime: currentK.openTime,
                            openIndex: i,
                            status: 'PENDING'
                        };
                        continue;
                    }
                }

                if (activeTrade.direction === 'LONG') {
                    if (currentK.low <= activeTrade.sl && currentK.high >= activeTrade.tp) {
                        activeTrade.status = 'SL';
                        activeTrade.closePrice = activeTrade.sl;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = -1.0 - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    } else if (currentK.low <= activeTrade.sl) {
                        activeTrade.status = 'SL';
                        activeTrade.closePrice = activeTrade.sl;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = -1.0 - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    } else if (currentK.high >= activeTrade.tp) {
                        activeTrade.status = 'TP';
                        activeTrade.closePrice = activeTrade.tp;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = activeTrade.rr - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    }
                } else if (activeTrade.direction === 'SHORT') {
                    if (currentK.high >= activeTrade.sl && currentK.low <= activeTrade.tp) {
                        activeTrade.status = 'SL';
                        activeTrade.closePrice = activeTrade.sl;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = -1.0 - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    } else if (currentK.high >= activeTrade.sl) {
                        activeTrade.status = 'SL';
                        activeTrade.closePrice = activeTrade.sl;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = -1.0 - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    } else if (currentK.low <= activeTrade.tp) {
                        activeTrade.status = 'TP';
                        activeTrade.closePrice = activeTrade.tp;
                        activeTrade.closeTime = currentK.openTime;
                        const frictionR = getFriction(activeTrade);
                        activeTrade.frictionR = frictionR;
                        activeTrade.pnl = activeTrade.rr - frictionR;
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    }
                }
            } else {
                if ((analysis.signal === 'LONG' || analysis.signal === 'SHORT') && analysis.rr > 1.0) {
                    activeTrade = {
                        symbol: symbol,
                        direction: analysis.signal,
                        entry: currentK.close,
                        tp: analysis.tp,
                        sl: analysis.sl,
                        rr: analysis.rr,
                        winRate: analysis.winRate,
                        openTime: currentK.openTime,
                        openIndex: i,
                        status: 'PENDING'
                    };
                }
            }
        }

        if (activeTrade) {
            const finalK = klines[klines.length - 1];
            const closePrice = finalK.close;
            const risk = Math.abs(activeTrade.entry - activeTrade.sl);
            let pnl = 0;
            if (risk > 0) {
                pnl = activeTrade.direction === 'LONG'
                    ? (closePrice - activeTrade.entry) / risk
                    : (activeTrade.entry - closePrice) / risk;
            }
            activeTrade.status = 'CLOSED';
            activeTrade.closePrice = closePrice;
            activeTrade.closeTime = finalK.openTime;
            const frictionR = getFriction(activeTrade);
            activeTrade.frictionR = frictionR;
            activeTrade.pnl = pnl - frictionR;
            trades.push({ ...activeTrade });
            activeTrade = null;
        }

        return trades;
    }

    // 運行歷史回測模擬引擎
    async runHistoricalBacktest() {
        const symbolInput = document.getElementById('backtest-symbol');
        const intervalSelect = document.getElementById('backtest-interval');
        const limitSelect = document.getElementById('backtest-limit');
        const runBtn = document.getElementById('run-backtest-btn');

        if (!symbolInput || !intervalSelect || !limitSelect || !runBtn) return;

        const top50Toggle = document.getElementById('backtest-top50-toggle');
        if (top50Toggle && top50Toggle.checked) {
            await this.runPortfolioBacktest();
            return;
        }

        const symbol = symbolInput.value.toUpperCase().trim().replace('/', '');
        const interval = intervalSelect.value;
        const limit = parseInt(limitSelect.value);

        if (!symbol) {
            alert('請輸入有效的交易對，例如 BTCUSDT');
            return;
        }

        runBtn.disabled = true;
        runBtn.innerText = '正在計算中...';
        const startTime = Date.now();
        let isSuccess = false;

        try {
            const rawKlines = await this.getBinanceData(symbol, interval, limit);
            if (!rawKlines || rawKlines.length < 100) {
                alert('獲取 K 線數據不足 (至少需要 100 根)，請檢查幣種代碼是否正確。');
                return;
            }

            const klines = rawKlines.map(d => ({
                openTime: Number(d.openTime),
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
                volume: parseFloat(d.volume)
            }));

            // 呼叫重構後的無副作用評估方法
            const trades = this.evaluateStrategy(klines, symbol, this.strategyConfig);

            this.renderBacktestResults(trades, klines);

            // UX 人工延遲，確保 Loading 狀態能被使用者看見
            const elapsed = Date.now() - startTime;
            const minTime = 500;
            if (elapsed < minTime) {
                await new Promise(resolve => setTimeout(resolve, minTime - elapsed));
            }

            isSuccess = true;
            runBtn.innerText = '✓ 回測完成';
            setTimeout(() => {
                runBtn.disabled = false;
                runBtn.innerText = '開始歷史回測';
            }, 1200);

        } catch (e) {
            console.error('Backtest error:', e);
            alert('回測過程發生錯誤，請檢查您的輸入與網絡。');
        } finally {
            if (!isSuccess) {
                runBtn.disabled = false;
                runBtn.innerText = '開始歷史回測';
            }
        }
    }

    // 策略參數網格搜尋最佳化 (Grid Search Optimizer)
    async runBacktestOptimization() {
        const symbolInput = document.getElementById('backtest-symbol');
        const intervalSelect = document.getElementById('backtest-interval');
        const limitSelect = document.getElementById('backtest-limit');
        const optBtn = document.getElementById('run-optimization-btn');
        const optCard = document.getElementById('backtest-optimization-card');
        const optList = document.getElementById('backtest-optimization-list');

        if (!symbolInput || !intervalSelect || !limitSelect || !optBtn) return;

        const top50Toggle = document.getElementById('backtest-top50-toggle');
        if (top50Toggle && top50Toggle.checked) {
            await this.runPortfolioOptimization();
            return;
        }

        const symbol = symbolInput.value.toUpperCase().trim().replace('/', '');
        const interval = intervalSelect.value;
        const limit = parseInt(limitSelect.value);

        if (!symbol) {
            alert('請輸入有效的交易對，例如 BTCUSDT');
            return;
        }

        optBtn.disabled = true;
        optBtn.innerText = '最佳化計算中...';
        
        // 隱藏舊的優化結果卡片
        if (optCard) optCard.style.display = 'none';

        try {
            const rawKlines = await this.getBinanceData(symbol, interval, limit);
            if (!rawKlines || rawKlines.length < 100) {
                alert('獲取 K 線數據不足 (至少需要 100 根)，請檢查幣種代碼是否正確。');
                return;
            }

            const klines = rawKlines.map(d => ({
                openTime: Number(d.openTime),
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
                volume: parseFloat(d.volume)
            }));

            // 網格搜尋參數候選值 (4x4 = 16種組合)
            const emaPeriods = [20, 50, 100, 200];
            const atrMultipliers = [1.0, 1.5, 2.0, 3.0];
            const results = [];

            // 執行網格搜尋
            for (const ema of emaPeriods) {
                for (const atr of atrMultipliers) {
                    const testConfig = {
                        emaPeriod: ema,
                        atrMultiplier: atr,
                        riskRatio: this.strategyConfig.riskRatio || 30
                    };

                    const trades = this.evaluateStrategy(klines, symbol, testConfig);
                    
                    const total = trades.length;
                    let winCount = 0;
                    let totalPnL = 0;

                    trades.forEach(t => {
                        totalPnL += t.pnl;
                        if (t.status === 'TP') {
                            winCount++;
                        } else if (t.status === 'CLOSED' && t.pnl > 0) {
                            winCount++;
                        }
                    });

                    const winRateVal = total > 0 ? (winCount / total * 100) : 0.0;

                    results.push({
                        ema: ema,
                        atr: atr,
                        totalTrades: total,
                        winRate: winRateVal,
                        totalPnL: totalPnL
                    });
                }
            }

            // 按累計收益 (totalPnL) 降序排列
            results.sort((a, b) => b.totalPnL - a.totalPnL);

            // 渲染結果列表
            if (optList) {
                optList.innerHTML = results.map((res, index) => {
                    const isTop1 = index === 0;
                    const pnlText = `${res.totalPnL >= 0 ? '+' : ''}${res.totalPnL.toFixed(2)} R`;
                    const pnlColor = res.totalPnL > 0 ? 'var(--text-green)' : (res.totalPnL < 0 ? '#f6465d' : 'var(--text-muted)');
                    
                    // 前三名使用加強色彩或標籤
                    const rankLabel = isTop1 
                        ? `<span style="color: #ffd700; font-weight: bold;">🥇 1 (推薦最優)</span>`
                        : (index === 1 
                            ? `<span style="color: #c0c0c0; font-weight: bold;">🥈 2</span>`
                            : (index === 2 
                                ? `<span style="color: #cd7f32; font-weight: bold;">🥉 3</span>`
                                : `${index + 1}`));

                    const rowStyle = isTop1 ? `background: rgba(255, 215, 0, 0.04); border-left: 3px solid #ffd700;` : '';

                    return `
                        <tr style="${rowStyle}">
                            <td style="font-weight: bold;">${rankLabel}</td>
                            <td style="font-family: monospace; font-weight: bold; color: var(--accent-color);">${res.ema} EMA</td>
                            <td style="font-family: monospace; font-weight: bold; color: var(--text-main);">${res.atr.toFixed(1)}x ATR</td>
                            <td>${res.totalTrades} 筆</td>
                            <td style="font-weight: 600;">${res.winRate.toFixed(1)}%</td>
                            <td style="font-family: monospace; font-weight: bold; font-size: 15px; color: ${pnlColor};">${pnlText}</td>
                            <td>
                                <button class="primary-btn-xs" style="padding: 4px 10px; font-size: 11px; width: auto; background: ${isTop1 ? 'linear-gradient(135deg, #00c6ff 0%, #0072ff 100%)' : 'rgba(255,255,255,0.08)'}" onclick="app.applyOptimalConfig(${res.ema}, ${res.atr})">套用參數</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            // 顯示結果面板
            if (optCard) {
                optCard.style.display = 'block';
                // 渲染參數最佳化二維熱力圖
                this.renderOptimizationHeatmap(results);
                // 捲動至結果面板位置
                optCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

        } catch (e) {
            console.error('Optimization error:', e);
            alert('策略最佳化計算過程中發生錯誤，請檢查您的輸入。');
        } finally {
            optBtn.disabled = false;
            optBtn.innerText = '最佳化策略參數';
        }
    }

    // 渲染參數最佳化二維熱力圖
    renderOptimizationHeatmap(results) {
        const heatmapEl = document.getElementById('backtest-optimization-heatmap');
        if (!heatmapEl) return;

        const emaPeriods = [20, 50, 100, 200];
        const atrMultipliers = [1.0, 1.5, 2.0, 3.0];

        // 將 results 轉為 O(1) 查找 Map
        const resultMap = {};
        results.forEach(res => {
            resultMap[`${res.ema}_${res.atr.toFixed(1)}`] = res;
        });

        // 找出累計收益的絕對值最大值，作為漸層比率基底
        let maxAbsPnL = 0;
        results.forEach(res => {
            const absVal = Math.abs(res.totalPnL);
            if (absVal > maxAbsPnL) maxAbsPnL = absVal;
        });

        // 1. 生成 Y 軸標籤 (ATR) - 由大至小排列
        let yLabelsHTML = '<div class="heatmap-y-axis">';
        const sortedAtrs = [...atrMultipliers].reverse();
        sortedAtrs.forEach(atr => {
            yLabelsHTML += `<div style="height: 100%; display: flex; align-items: center; justify-content: flex-end;">${atr.toFixed(1)}x</div>`;
        });
        yLabelsHTML += '</div>';

        // 2. 生成 4x4 Grid 格子
        let gridHTML = '<div class="heatmap-grid-container">';
        gridHTML += '<div class="heatmap-grid">';
        for (const atr of sortedAtrs) {
            for (const ema of emaPeriods) {
                const key = `${ema}_${atr.toFixed(1)}`;
                const res = resultMap[key] || { totalTrades: 0, winRate: 0, totalPnL: 0 };
                
                // 動態計算漸層背景強度 (Alpha 介於 0.1 到 0.8)
                let cellBg = 'rgba(255, 255, 255, 0.03)';
                if (res.totalPnL > 0) {
                    const alpha = maxAbsPnL > 0 ? 0.1 + 0.7 * (res.totalPnL / maxAbsPnL) : 0.4;
                    cellBg = `rgba(14, 203, 129, ${alpha})`;
                } else if (res.totalPnL < 0) {
                    const alpha = maxAbsPnL > 0 ? 0.1 + 0.7 * (Math.abs(res.totalPnL) / maxAbsPnL) : 0.4;
                    cellBg = `rgba(246, 70, 93, ${alpha})`;
                }
                
                const pnlText = `${res.totalPnL >= 0 ? '+' : ''}${res.totalPnL.toFixed(1)} R`;
                
                gridHTML += `
                    <div class="heatmap-cell" style="background: ${cellBg};" onclick="app.applyOptimalConfig(${ema}, ${atr})"
                         data-ema="${ema}" data-atr="${atr}" data-trades="${res.totalTrades}" data-winrate="${res.winRate.toFixed(1)}" data-pnl="${res.totalPnL.toFixed(2)}">
                        <span class="cell-pnl">${pnlText}</span>
                        <span class="cell-winrate">${res.winRate.toFixed(0)}% 勝率</span>
                    </div>`;
            }
        }
        gridHTML += '</div>';
        
        // 插入自定義 Tooltip 提示窗
        gridHTML += '<div class="heatmap-tooltip" id="heatmap-tooltip-el"></div>';
        gridHTML += '</div>';

        // 3. 生成 X 軸標籤 (EMA)
        let xLabelsHTML = '<div class="heatmap-x-axis">';
        emaPeriods.forEach(ema => {
            xLabelsHTML += `<div style="flex: 1; text-align: center;">${ema} EMA</div>`;
        });
        xLabelsHTML += '</div>';

        // 寫入 DOM
        heatmapEl.innerHTML = yLabelsHTML + gridHTML + xLabelsHTML;

        // 4. 綁定 Tooltip 監聽事件
        const tooltipEl = document.getElementById('heatmap-tooltip-el');
        const cells = heatmapEl.querySelectorAll('.heatmap-cell');
        
        cells.forEach(cell => {
            cell.addEventListener('mouseenter', () => {
                const ema = cell.dataset.ema;
                const atr = parseFloat(cell.dataset.atr).toFixed(1);
                const trades = cell.dataset.trades;
                const winrate = cell.dataset.winrate;
                const pnl = parseFloat(cell.dataset.pnl);
                
                const pnlText = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} R`;
                const pnlColor = pnl > 0 ? 'var(--green)' : (pnl < 0 ? 'var(--red)' : 'var(--text-muted)');
                
                tooltipEl.innerHTML = `
                    <div class="tooltip-title">${ema} EMA / ${atr}x ATR</div>
                    <div><b>總交易數：</b>${trades} 筆</div>
                    <div><b>預估勝率：</b>${winrate}%</div>
                    <div><b>累計收益：</b><span style="color: ${pnlColor}; font-weight: bold;">${pnlText}</span></div>
                    <div style="margin-top: 6px; font-size: 10px; color: var(--accent-color); text-align: center; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px;">🎯 點選快速套用參數</div>
                `;
                tooltipEl.style.display = 'block';
            });
            
            cell.addEventListener('mousemove', (e) => {
                const containerRect = heatmapEl.getBoundingClientRect();
                // 將 tooltip 座標限制在容器相對定位範圍內
                const x = e.clientX - containerRect.left + 15;
                const y = e.clientY - containerRect.top - 100; // 稍往上移避免遮擋游標
                tooltipEl.style.left = `${x}px`;
                tooltipEl.style.top = `${y}px`;
            });
            
            cell.addEventListener('mouseleave', () => {
                tooltipEl.style.display = 'none';
            });
        });
    }

    // 套用最優參數並即時重繪常規回測
    async applyOptimalConfig(ema, atr) {
        if (!confirm(`確定要將系統的策略設定調整為「${ema} EMA」與「${atr.toFixed(1)}x ATR」嗎？\n這將會同步變更您的雲端設定與背景自動掃描腳本參數。`)) return;

        // 1. 更新自定義參數面板的 DOM 數值
        const emaInput = document.getElementById('strategy-ema-period');
        const atrInput = document.getElementById('strategy-atr-multiplier');

        if (emaInput) emaInput.value = ema;
        if (atrInput) atrInput.value = atr;

        // 2. 更新記憶體與 LocalStorage
        this.strategyConfig.emaPeriod = ema;
        this.strategyConfig.atrMultiplier = atr;

        if (this.currentUser) {
            const email = this.currentUser.email;
            localStorage.setItem(`snr_strategy_config_${email}`, JSON.stringify(this.strategyConfig));
            
            // 3. 同步至 Firebase Realtime Database
            await this.syncToCloud();
        }

        alert(`已成功套用新參數設定！\n系統將自動重新運行歷史回測以展示最新資金走勢與明細。`);

        // 4. 自動觸發並重新跑一次回測
        this.runHistoricalBacktest();
    }

    // 更新回測進度條
    updateBacktestProgress(statusText, percent) {
        const card = document.getElementById('backtest-progress-card');
        const statusEl = document.getElementById('backtest-progress-status');
        const percentEl = document.getElementById('backtest-progress-percent');
        const barEl = document.getElementById('backtest-progress-bar');

        if (card) card.style.display = 'block';
        if (statusEl) statusEl.innerText = statusText;
        if (percentEl) percentEl.innerText = `${Math.round(percent)}%`;
        if (barEl) barEl.style.width = `${percent}%`;
    }

    // 隱藏回測進度條
    hideBacktestProgress() {
        const card = document.getElementById('backtest-progress-card');
        if (card) card.style.display = 'none';
    }

    // 運行多標的 (前 50 大) 綜合回測
    async runPortfolioBacktest() {
        const intervalSelect = document.getElementById('backtest-interval');
        const limitSelect = document.getElementById('backtest-limit');
        const runBtn = document.getElementById('run-backtest-btn');

        if (!intervalSelect || !limitSelect || !runBtn) return;

        const interval = intervalSelect.value;
        const limit = parseInt(limitSelect.value);

        runBtn.disabled = true;
        runBtn.innerText = '綜合回測中...';

        try {
            // 1. 獲取成交量前 50 大 USDT 交易對
            this.updateBacktestProgress('正在獲取前50大熱門標的...', 2);
            const tickerUrl = 'https://data-api.binance.vision/api/v3/ticker/24hr';
            const tickers = await (await fetch(tickerUrl)).json();
            const top50 = tickers
                .filter(t => t.symbol.endsWith('USDT') && !t.symbol.startsWith('RLUSD') && !t.symbol.startsWith('FDUSD') && t.symbol !== 'UUSDT' && t.symbol !== 'TRXUSDT')
                .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
                .slice(0, 50)
                .map(t => t.symbol);

            const allKlines = {};
            
            // 2. 異步序列下載 K 線數據，防止限頻與卡死
            for (let i = 0; i < top50.length; i++) {
                const sym = top50[i];
                const progressPercent = (i / top50.length) * 70; // 下載進度佔 70%
                this.updateBacktestProgress(`正在下載 K 線數據: ${sym} (${i + 1}/${top50.length})...`, progressPercent);
                
                try {
                    const rawData = await this.getBinanceData(sym, interval, limit);
                    if (rawData && rawData.length >= 100) {
                        allKlines[sym] = rawData.map(d => ({
                            openTime: Number(d.openTime),
                            open: parseFloat(d.open),
                            high: parseFloat(d.high),
                            low: parseFloat(d.low),
                            close: parseFloat(d.close),
                            volume: parseFloat(d.volume)
                        }));
                    }
                } catch (err) {
                    console.error(`下載 ${sym} K線失敗:`, err);
                }
                await new Promise(resolve => setTimeout(resolve, 30));
            }

            // 3. 多標的綜合評估計算
            this.updateBacktestProgress('正在計算多幣種策略分析結果...', 75);
            const combinedTrades = [];
            
            for (const sym in allKlines) {
                const klines = allKlines[sym];
                const trades = this.evaluateStrategy(klines, sym, this.strategyConfig);
                combinedTrades.push(...trades);
            }

            // 4. 按交易時間由舊到新排序，以便繪製組合資金走勢圖
            this.updateBacktestProgress('正在排序交易紀錄並繪製資金走勢...', 90);
            combinedTrades.sort((a, b) => a.openTime - b.openTime);

            // 5. 渲染回測數據
            this.renderBacktestResults(combinedTrades, []);
            this.updateBacktestProgress('✓ 綜合回測完成！', 100);

            setTimeout(() => {
                this.hideBacktestProgress();
                runBtn.disabled = false;
                runBtn.innerText = '開始歷史回測';
            }, 1000);

        } catch (e) {
            console.error('Portfolio backtest error:', e);
            alert('多幣種綜合回測過程中發生錯誤，請檢查您的網絡。');
            this.hideBacktestProgress();
            runBtn.disabled = false;
            runBtn.innerText = '開始歷史回測';
        }
    }

    // 運行多標的 (前 50 大) 綜合參數最佳化
    async runPortfolioOptimization() {
        const intervalSelect = document.getElementById('backtest-interval');
        const limitSelect = document.getElementById('backtest-limit');
        const optBtn = document.getElementById('run-optimization-btn');
        const optCard = document.getElementById('backtest-optimization-card');
        const optList = document.getElementById('backtest-optimization-list');

        if (!intervalSelect || !limitSelect || !optBtn) return;

        const interval = intervalSelect.value;
        const limit = parseInt(limitSelect.value);

        optBtn.disabled = true;
        optBtn.innerText = '綜合最佳化中...';

        if (optCard) optCard.style.display = 'none';

        try {
            // 1. 獲取成交量前 50 大 USDT 交易對
            this.updateBacktestProgress('正在獲取前50大熱門標的...', 2);
            const tickerUrl = 'https://data-api.binance.vision/api/v3/ticker/24hr';
            const tickers = await (await fetch(tickerUrl)).json();
            const top50 = tickers
                .filter(t => t.symbol.endsWith('USDT') && !t.symbol.startsWith('RLUSD') && !t.symbol.startsWith('FDUSD') && t.symbol !== 'UUSDT' && t.symbol !== 'TRXUSDT')
                .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
                .slice(0, 50)
                .map(t => t.symbol);

            const allKlines = {};
            
            // 2. 異步序列下載 K 線數據 (進度佔 0% ~ 40%)
            for (let i = 0; i < top50.length; i++) {
                const sym = top50[i];
                const progressPercent = (i / top50.length) * 40;
                this.updateBacktestProgress(`正在下載 K 線數據: ${sym} (${i + 1}/${top50.length})...`, progressPercent);
                
                try {
                    const rawData = await this.getBinanceData(sym, interval, limit);
                    if (rawData && rawData.length >= 100) {
                        allKlines[sym] = rawData.map(d => ({
                            openTime: Number(d.openTime),
                            open: parseFloat(d.open),
                            high: parseFloat(d.high),
                            low: parseFloat(d.low),
                            close: parseFloat(d.close),
                            volume: parseFloat(d.volume)
                        }));
                    }
                } catch (err) {
                    console.error(`下載 ${sym} K線失敗:`, err);
                }
                await new Promise(resolve => setTimeout(resolve, 30));
            }

            // 3. 網格搜尋參數最佳化評估 (進度佔 40% ~ 95%)
            const emaPeriods = [20, 50, 100, 200];
            const atrMultipliers = [1.0, 1.5, 2.0, 3.0];
            const results = [];

            const totalCombinations = 16;
            let combinationIndex = 0;

            for (const ema of emaPeriods) {
                for (const atr of atrMultipliers) {
                    const testConfig = {
                        emaPeriod: ema,
                        atrMultiplier: atr,
                        riskRatio: this.strategyConfig.riskRatio || 30
                    };

                    const progressPercent = 40 + (combinationIndex / totalCombinations) * 55;
                    this.updateBacktestProgress(`評估網格組合: ${ema} EMA + ${atr.toFixed(1)}x ATR (${combinationIndex + 1}/${totalCombinations})...`, progressPercent);

                    let totalTradesCombined = 0;
                    let winTradesCombined = 0;
                    let totalPnLCombined = 0;

                    for (const sym in allKlines) {
                        const klines = allKlines[sym];
                        const trades = this.evaluateStrategy(klines, sym, testConfig);

                        trades.forEach(t => {
                            totalPnLCombined += t.pnl;
                            if (t.status === 'TP') {
                                winTradesCombined++;
                            } else if (t.status === 'CLOSED' && t.pnl > 0) {
                                winTradesCombined++;
                            }
                        });
                        totalTradesCombined += trades.length;
                    }

                    const combinedWinRateVal = totalTradesCombined > 0 ? (winTradesCombined / totalTradesCombined * 100) : 0.0;

                    results.push({
                        ema: ema,
                        atr: atr,
                        totalTrades: totalTradesCombined,
                        winRate: combinedWinRateVal,
                        totalPnL: totalPnLCombined
                    });

                    combinationIndex++;
                    await new Promise(resolve => setTimeout(resolve, 10)); // 防止卡死
                }
            }

            // 4. 綜合累計收益降序排序
            results.sort((a, b) => b.totalPnL - a.totalPnL);

            // 5. 渲染最佳化結果表格
            if (optList) {
                optList.innerHTML = results.map((res, index) => {
                    const isTop1 = index === 0;
                    const pnlText = `${res.totalPnL >= 0 ? '+' : ''}${res.totalPnL.toFixed(2)} R`;
                    const pnlColor = res.totalPnL > 0 ? 'var(--text-green)' : (res.totalPnL < 0 ? '#f6465d' : 'var(--text-muted)');
                    
                    const rankLabel = isTop1 
                        ? `<span style="color: #ffd700; font-weight: bold;">🥇 1 (推薦最優)</span>`
                        : (index === 1 
                            ? `<span style="color: #c0c0c0; font-weight: bold;">🥈 2</span>`
                            : (index === 2 
                                ? `<span style="color: #cd7f32; font-weight: bold;">🥉 3</span>`
                                : `${index + 1}`));

                    const rowStyle = isTop1 ? `background: rgba(255, 215, 0, 0.04); border-left: 3px solid #ffd700;` : '';

                    return `
                        <tr style="${rowStyle}">
                            <td style="font-weight: bold;">${rankLabel}</td>
                            <td style="font-family: monospace; font-weight: bold; color: var(--accent-color);">${res.ema} EMA</td>
                            <td style="font-family: monospace; font-weight: bold; color: var(--text-main);">${res.atr.toFixed(1)}x ATR</td>
                            <td>${res.totalTrades} 筆</td>
                            <td style="font-weight: 600;">${res.winRate.toFixed(1)}%</td>
                            <td style="font-family: monospace; font-weight: bold; font-size: 15px; color: ${pnlColor};">${pnlText}</td>
                            <td>
                                <button class="primary-btn-xs" style="padding: 4px 10px; font-size: 11px; width: auto; background: ${isTop1 ? 'linear-gradient(135deg, #00c6ff 0%, #0072ff 100%)' : 'rgba(255,255,255,0.08)'}" onclick="app.applyOptimalConfig(${res.ema}, ${res.atr})">套用參數</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            this.updateBacktestProgress('✓ 綜合最佳化完成！', 100);

            if (optCard) {
                optCard.style.display = 'block';
                // 渲染參數最佳化二維熱力圖
                this.renderOptimizationHeatmap(results);
                optCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            setTimeout(() => this.hideBacktestProgress(), 1000);

        } catch (e) {
            console.error('Portfolio optimization error:', e);
            alert('多幣種綜合最佳化過程中發生錯誤，請檢查您的網絡。');
            this.hideBacktestProgress();
        } finally {
            optBtn.disabled = false;
            optBtn.innerText = '最佳化策略參數';
        }
    }

    // 渲染回測指標與交易明細表格
    renderBacktestResults(trades, klines) {
        this.lastBacktestTrades = trades; // 保存交易紀錄以供匯出 CSV/PDF

        // 控制回測匯出按鈕的顯示狀態
        const csvBtn = document.getElementById('export-backtest-csv-btn');
        const pdfBtn = document.getElementById('export-backtest-pdf-btn');
        if (csvBtn && pdfBtn) {
            if (trades.length > 0) {
                csvBtn.style.display = 'inline-block';
                pdfBtn.style.display = 'inline-block';
            } else {
                csvBtn.style.display = 'none';
                pdfBtn.style.display = 'none';
            }
        }

        const total = trades.length;
        let winCount = 0;
        let lossCount = 0;
        let totalPnL = 0;

        trades.forEach(t => {
            totalPnL += t.pnl;
            if (t.status === 'TP') {
                winCount++;
            } else if (t.status === 'SL') {
                lossCount++;
            } else if (t.status === 'CLOSED') {
                if (t.pnl > 0) {
                    winCount++;
                } else {
                    lossCount++;
                }
            }
        });

        const winRate = total > 0 ? `${((winCount / total) * 100).toFixed(1)}%` : '--';
        const pnlStr = totalPnL >= 0 ? `+${totalPnL.toFixed(2)} R` : `${totalPnL.toFixed(2)} R`;
        const pnlColor = totalPnL >= 0 ? 'var(--green)' : 'var(--red)';

        document.getElementById('backtest-stat-total').innerText = `${total} 筆`;
        document.getElementById('backtest-stat-winrate').innerText = winRate;
        
        const pnlEl = document.getElementById('backtest-stat-pnl');
        if (pnlEl) {
            pnlEl.innerText = pnlStr;
            pnlEl.style.color = pnlColor;
        }
        
        document.getElementById('backtest-stat-ratio').innerText = `${winCount} / ${lossCount}`;

        this.updateBacktestChart(trades);

        const detailsList = document.getElementById('backtest-details-list');
        if (!detailsList) return;

        if (trades.length === 0) {
            detailsList.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center; padding: 40px; color: var(--text-muted);">
                        回測完成。期間策略未產生任何交易訊號。
                    </td>
                </tr>
            `;
            return;
        }

        detailsList.innerHTML = trades.map(t => {
            const formatTime = (ts) => {
                const date = new Date(ts);
                return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            };

            const dirClass = t.direction === 'LONG' ? 'text-green' : 'text-red';
            const dirLabel = t.direction === 'LONG' ? '買入 (LONG) 🟢' : '賣出 (SHORT) 🔴';
            
            let statusHTML = '';
            let pnlClass = 'text-green';
            let pnlText = `+${t.pnl.toFixed(2)} R`;

            if (t.pnl < 0) {
                pnlClass = 'text-red';
                pnlText = `${t.pnl.toFixed(2)} R`;
            } else if (t.pnl === 0) {
                pnlClass = 'text-muted';
                pnlText = `0.00 R`;
            }

            if (t.status === 'TP') {
                statusHTML = `<span class="status-pill tp">已止盈 🎯</span>`;
            } else if (t.status === 'SL') {
                statusHTML = `<span class="status-pill sl">已止損 ❌</span>`;
            } else if (t.status === 'CLOSED') {
                statusHTML = `<span class="status-pill closed" style="background: rgba(8,160,250,0.1); color: #08a0fa; border: 1px solid rgba(8,160,250,0.2);">已平倉 🔄</span>`;
            }

            return `
                <tr>
                    <td style="font-family: monospace; font-weight: 700;">${t.symbol}</td>
                    <td class="${dirClass}" style="font-weight: 700;">${dirLabel}</td>
                    <td style="color: var(--text-muted);">${formatTime(t.openTime)}</td>
                    <td style="color: var(--text-muted);">${formatTime(t.closeTime)}</td>
                    <td style="font-family: monospace;">$${this.formatPrice(t.entry)}</td>
                    <td style="font-family: monospace;">$${this.formatPrice(t.closePrice)}</td>
                    <td style="font-weight: 700; color: var(--accent-color);">${(t.winRate * 100).toFixed(0)}%</td>
                    <td>${statusHTML}</td>
                    <td class="${pnlClass}" style="font-family: monospace; font-weight: 700; font-size: 15px;">${pnlText}</td>
                </tr>
            `;
        }).join('');
    }

    // 更新回測資金曲線圖
    updateBacktestChart(trades) {
        if (!this.backtestLineSeries) return;

        const settledTrades = [...trades].sort((a, b) => a.closeTime - b.closeTime);
        const chartPoints = [];
        let currentPnL = 0;

        if (settledTrades.length > 0) {
            const firstTime = Math.floor(settledTrades[0].openTime / 1000) - 3600;
            chartPoints.push({ time: firstTime, value: 0.00 });
        } else {
            chartPoints.push({ time: Math.floor(Date.now() / 1000) - 3600, value: 0.00 });
        }

        let lastTime = chartPoints[0].time;
        settledTrades.forEach(t => {
            currentPnL += t.pnl;
            let closeTimeSec = Math.floor(t.closeTime / 1000);
            if (closeTimeSec <= lastTime) {
                closeTimeSec = lastTime + 1;
            }
            lastTime = closeTimeSec;

            chartPoints.push({
                time: closeTimeSec,
                value: parseFloat(currentPnL.toFixed(2))
            });
        });

        this.backtestLineSeries.setData(chartPoints);
        
        if (this.backtestChart && chartPoints.length > 0) {
            this.backtestChart.timeScale().fitContent();
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
                let intervalMs = 60 * 1000;
                if (record.interval === '5m') intervalMs = 5 * 60 * 1000;
                else if (record.interval === '15m') intervalMs = 15 * 60 * 1000;
                else if (record.interval === '1h') intervalMs = 60 * 60 * 1000;
                else if (record.interval === '4h') intervalMs = 4 * 60 * 60 * 1000;
                else if (record.interval === '1d') intervalMs = 24 * 60 * 60 * 1000;

                const queryStartTime = record.id - intervalMs;
                const url = `https://data-api.binance.vision/api/v3/klines?symbol=${record.symbol}&interval=${record.interval}&startTime=${queryStartTime}&limit=500`;
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

                let initialSl = record.initialSl !== undefined ? record.initialSl : record.sl;
                const oneRSpace = Math.abs(record.entry - initialSl);
                
                if (record.initialSl === undefined) {
                    record.initialSl = record.sl;
                    hasUpdates = true;
                }

                // 每次歷史回溯重播前，先將狀態重置為開倉初始狀態，防止已觸發保本的狀態殘留導致歷史誤判
                record.sl = initialSl;
                record.isBreakEven = false;

                // 遍歷 K 線進行結算與移動止損檢測
                for (let k = 0; k < klines.length; k++) {
                    const klineOpenTime = klines[k][0];
                    // 改為小於 record.id，跳過與開倉時間重疊的那根 K 線，防範進場前開盤之歷史插針誤判
                    if (klineOpenTime < record.id) continue;

                    const high = parseFloat(klines[k][2]);
                    const low = parseFloat(klines[k][3]);

                    const cleanSymbol = record.symbol.replace('USDT', '');

                    let justTriggeredBE = false;
                    let tempSl = record.sl;
                    let tempIsBreakEven = record.isBreakEven;

                    // 1. 移動止損 (Break-even) 預判定 (獲利達 1R 時，標記準備將止損移至 Entry 保本點)
                    if (!record.isBreakEven) {
                        if (record.type === 'LONG') {
                            if (high >= record.entry + oneRSpace) {
                                tempSl = record.entry;
                                tempIsBreakEven = true;
                                justTriggeredBE = true;
                            }
                        } else if (record.type === 'SHORT') {
                            if (low <= record.entry - oneRSpace) {
                                tempSl = record.entry;
                                tempIsBreakEven = true;
                                justTriggeredBE = true;
                            }
                        }
                    }

                    // 2. TP / SL 結算判定 (當根剛觸發保本時，止損判定仍使用初始止損 initialSl，避免當根 K 線震盪直接被保本平倉)
                    const activeSl = justTriggeredBE ? initialSl : record.sl;

                    if (record.type === 'LONG') {
                        if (low <= activeSl) {
                            record.status = 'SL';
                            // 同根 K 線若跌破 initialSl 則視為真實止損，不可算作保本
                            record.isBreakEven = false;
                            record.sl = initialSl;
                            this.settlePaperTrade(record, 'SL');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `❌ 交易已結算 (Stop Loss)`,
                                `${cleanSymbol} LONG 交易已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            this.sendTelegramSettlementNotification(record, 'SL');
                            break;
                        }
                        if (high >= record.tp) {
                            record.status = 'TP';
                            this.settlePaperTrade(record, 'TP');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `🎯 交易已結算 (Take Profit)`,
                                `${cleanSymbol} LONG 交易已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            this.sendTelegramSettlementNotification(record, 'TP');
                            break;
                        }
                    } else if (record.type === 'SHORT') {
                        if (high >= activeSl) {
                            record.status = 'SL';
                            // 同根 K 線若突破 initialSl 則視為真實止損，不可算作保本
                            record.isBreakEven = false;
                            record.sl = initialSl;
                            this.settlePaperTrade(record, 'SL');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `❌ 交易已結算 (Stop Loss)`,
                                `${cleanSymbol} SHORT 交易已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            this.sendTelegramSettlementNotification(record, 'SL');
                            break;
                        }
                        if (low <= record.tp) {
                            record.status = 'TP';
                            this.settlePaperTrade(record, 'TP');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `🎯 交易已結算 (Take Profit)`,
                                `${cleanSymbol} SHORT 交易已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            this.sendTelegramSettlementNotification(record, 'TP');
                            break;
                        }
                    }

                    // 3. 若當根 K 線結束且未被平倉，正式寫入移動止損狀態並發送通知
                    if (justTriggeredBE && record.status === 'PENDING') {
                        record.sl = tempSl;
                        record.isBreakEven = tempIsBreakEven;
                        hasUpdates = true;

                        this.showNotification(
                            `🛡️ 移動止損已啟用`,
                            `${cleanSymbol} ${record.type} 交易獲利已達 1R，止損已移至進場價 $${this.formatPrice(record.entry)}。`
                        );
                        if (!record.notified1to1) {
                                    record.notified1to1 = true;
                                    this.sendTelegramBreakEvenNotification(record);
                                }
                    }
                }

                // 4. 當前最新價格 (currentPrice) 的即時 TP/SL 與移動止損判定，補足當前未完結 K 線的最新波動
                if (record.status === 'PENDING') {
                    const cleanSymbol = record.symbol.replace('USDT', '');
                    
                    // (A) 移動止損即時判定
                    if (!record.isBreakEven) {
                        if (record.type === 'LONG') {
                            if (currentPrice >= record.entry + oneRSpace) {
                                record.sl = record.entry;
                                record.isBreakEven = true;
                                hasUpdates = true;
                                
                                this.showNotification(
                                    `🛡️ 移動止損已啟用`,
                                    `${cleanSymbol} LONG 交易獲利已達 1R，止損已移至進場價 $${this.formatPrice(record.entry)}。`
                                );
                                if (!record.notified1to1) {
                                    record.notified1to1 = true;
                                    this.sendTelegramBreakEvenNotification(record);
                                }
                            }
                        } else if (record.type === 'SHORT') {
                            if (currentPrice <= record.entry - oneRSpace) {
                                record.sl = record.entry;
                                record.isBreakEven = true;
                                hasUpdates = true;
                                
                                this.showNotification(
                                    `🛡️ 移動止損已啟用`,
                                    `${cleanSymbol} SHORT 交易獲利已達 1R，止損已移至進場價 $${this.formatPrice(record.entry)}。`
                                );
                                if (!record.notified1to1) {
                                    record.notified1to1 = true;
                                    this.sendTelegramBreakEvenNotification(record);
                                }
                            }
                        }
                    }

                    // (B) TP / SL 即時判定
                    if (record.type === 'LONG') {
                        if (currentPrice <= record.sl) {
                            record.status = 'SL';
                            this.settlePaperTrade(record, 'SL');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `❌ 交易已結算 (Stop Loss)`,
                                `${cleanSymbol} LONG 交易已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            this.sendTelegramSettlementNotification(record, 'SL');
                        } else if (currentPrice >= record.tp) {
                            record.status = 'TP';
                            this.settlePaperTrade(record, 'TP');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `🎯 交易已結算 (Take Profit)`,
                                `${cleanSymbol} LONG 交易已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            this.sendTelegramSettlementNotification(record, 'TP');
                        }
                    } else if (record.type === 'SHORT') {
                        if (currentPrice >= record.sl) {
                            record.status = 'SL';
                            this.settlePaperTrade(record, 'SL');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `❌ 交易已結算 (Stop Loss)`,
                                `${cleanSymbol} SHORT 交易已被止損於 $${this.formatPrice(record.sl)}。`
                            );
                            this.sendTelegramSettlementNotification(record, 'SL');
                        } else if (currentPrice <= record.tp) {
                            record.status = 'TP';
                            this.settlePaperTrade(record, 'TP');
                            hasUpdates = true;
                            
                            this.showNotification(
                                `🎯 交易已結算 (Take Profit)`,
                                `${cleanSymbol} SHORT 交易已成功止盈於 $${this.formatPrice(record.tp)}！`
                            );
                            this.sendTelegramSettlementNotification(record, 'TP');
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
            this.updatePaperAccountUI();
            this.renderHistory(false);
            this.syncToCloud(); // 結算狀態更新後，異步同步至雲端
        }
    }

    async sendTelegramBreakEvenNotification(record) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_telegram_config_${email}`;
        
        let config = {};
        try { config = JSON.parse(localStorage.getItem(configKey) || '{}'); } catch (e) { return; }
        const { telegramToken, telegramChatId } = config;
        if (!telegramToken || !telegramChatId) return;

        const cleanSymbol = record.symbol.replace('USDT', '');
        const messageText = `🛡️【移動止損保本警報】\n\n您的 ${cleanSymbol} ${record.type} 交易已獲利達到 1R 空間！\n\n系統已自動將該持倉之止損位（SL）修改為您的進場價：$${this.formatPrice(record.entry)}。\n當前該筆交易已鎖定零風險保本！`;

        try {
            const corsProxy = 'https://corsproxy.io/?';
            const url = corsProxy + `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramChatId, text: messageText })
            });
        } catch (e) { console.error('Error sending BE telegram notification:', e); }
    }

    async sendTelegramSettlementNotification(record, status) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_telegram_config_${email}`;
        
        let config = {};
        try { config = JSON.parse(localStorage.getItem(configKey) || '{}'); } catch (e) { return; }
        const { telegramToken, telegramChatId } = config;
        if (!telegramToken || !telegramChatId) return;

        const cleanSymbol = record.symbol.replace('USDT', '');
        const profitUSDT = record.realizedProfit !== undefined ? record.realizedProfit : 0;
        const statusText = status === 'TP' ? '🎯【交易已成功止盈】' : '❌【交易已被止損出場】';
        const profitSign = profitUSDT >= 0 ? `+${profitUSDT.toFixed(2)}` : `${profitUSDT.toFixed(2)}`;
        
        let messageText = `${statusText}\n\n`;
        messageText += `交易對：${cleanSymbol}/USDT (${record.interval.toUpperCase()})\n`;
        messageText += `方向：${record.type}\n`;
        messageText += `進場價：$${this.formatPrice(record.entry)}\n`;
        messageText += `出場價：$${this.formatPrice(status === 'TP' ? record.tp : record.sl)}\n`;
        messageText += `實現盈虧：${profitSign} USDT\n\n`;
        messageText += `請前往平台查看您的模擬帳戶權益明細！\n`;
        messageText += `網址：https://spontaneous-kheer-c470e5.netlify.app/`;

        try {
            const corsProxy = 'https://corsproxy.io/?';
            const url = corsProxy + `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramChatId, text: messageText })
            });
        } catch (e) { console.error('Error sending settlement telegram notification:', e); }
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

    async syncToCloud(forceLocalBalance = false) {
        if (!this.db || !this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        const tgConfigKey = `snr_telegram_config_${email}`;
        const strategyConfigKey = `snr_strategy_config_${email}`;
        
        let localHistory = [];
        try {
            localHistory = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            localHistory = [];
        }

        let telegramConfig = {};
        try {
            telegramConfig = JSON.parse(localStorage.getItem(tgConfigKey) || '{}');
        } catch (e) {
            telegramConfig = {};
        }

        let strategyConfig = {};
        try {
            strategyConfig = JSON.parse(localStorage.getItem(strategyConfigKey) || '{}');
        } catch (e) {
            strategyConfig = {};
        }

        try {
            const safeEmail = email.replace(/\./g, '_');
            const dbRef = this.db.ref('users/' + safeEmail);
            
            // 1. 先從 Firebase 雲端載入最新的歷史紀錄與餘額，避免直接覆蓋抹端(GitHub Actions)產生的機會
            const snapshot = await dbRef.once('value');
            let cloudHistory = [];
            let cloudPaperBalance = this.paperBalance;
            if (snapshot.exists()) {
                const cloudData = snapshot.val();
                cloudHistory = cloudData.history || [];
                if (cloudData.blacklistedSymbols && Array.isArray(cloudData.blacklistedSymbols)) {
                    this.customBlacklist = cloudData.blacklistedSymbols;
                    this.renderCustomBlacklistTags();
                }
                if (cloudData.paperBalance !== undefined) {
                    cloudPaperBalance = parseFloat(cloudData.paperBalance);
                }
            }

            // 2. 合併本地與雲端歷史紀錄 (若 forceLocalBalance 則強制採用本地歷史，通常用於清空歷史重置)
            const mergedHistory = forceLocalBalance ? localHistory : this.mergeHistory(localHistory, cloudHistory);

            // 3. 處理模擬餘額的同步 (若本地在此次分析中無狀態改變，則以雲端最新的餘額為準；若 forceLocalBalance 則以本地重置餘額為準)
            let finalPaperBalance = this.paperBalance;
            if (!forceLocalBalance && snapshot.exists()) {
                const cloudData = snapshot.val();
                if (cloudData.paperBalance !== undefined) {
                    const localHasUpdates = localHistory.some((lh) => {
                        const ch = cloudHistory.find(c => c.id === lh.id);
                        return !ch || ch.status !== lh.status;
                    });
                    if (!localHasUpdates) {
                        finalPaperBalance = parseFloat(cloudData.paperBalance);
                        this.paperBalance = finalPaperBalance;
                        localStorage.setItem(`snr_paper_balance_${email}`, finalPaperBalance);
                    }
                }
            }

            // 4. 判斷是否需要執行 Firebase 寫入 (歷史紀錄與餘額有實質改變時才寫入，減少流量消耗)
            const localHistStr = JSON.stringify(localHistory);
            const mergedHistStr = JSON.stringify(mergedHistory);
            const cloudHistStr = JSON.stringify(cloudHistory);
            
            const hasHistoryChange = localHistStr !== mergedHistStr || cloudHistStr !== mergedHistStr || forceLocalBalance;
            const hasBalanceChange = finalPaperBalance !== cloudPaperBalance || forceLocalBalance;

            // 只要本地與合併結果不同，就將最新歷史紀錄存入 localStorage 並渲染 UI
            if (localHistStr !== mergedHistStr) {
                localStorage.setItem(historyKey, mergedHistStr);
                this.renderHistory(false);
            }

            // 如果雲端資料與最新合併結果有差異，才執行 Firebase 更新
            if (hasHistoryChange || hasBalanceChange) {
                await dbRef.update({
                    lastSymbol: this.symbol,
                    lastInterval: this.interval,
                    history: mergedHistory,
                    telegramConfig: telegramConfig,
                    strategyConfig: strategyConfig,
                    blacklistedSymbols: this.customBlacklist || [],
                    paperBalance: finalPaperBalance,
                    updatedAt: firebase.database.ServerValue.TIMESTAMP
                });
                console.log('Firebase 雲端與本地歷史紀錄雙向同步成功！');
            }

            this.updatePaperAccountUI();

        } catch (e) {
            console.error("Firebase sync save error:", e);
        }
    }

    // 輔助函式：合併本地與雲端的歷史紀錄，並優先採用最新結算狀態
    mergeHistory(localHist, cloudHist) {
        const mergedMap = new Map();
        localHist.forEach(item => {
            if (item && item.id) mergedMap.set(item.id, item);
        });
        cloudHist.forEach(item => {
            if (item && item.id) {
                const localItem = mergedMap.get(item.id);
                if (!localItem) {
                    mergedMap.set(item.id, item);
                } else {
                    // 如果本地是 PENDING，而雲端有更新狀態 (例如在 Actions 中已被結算)，則以雲端為主
                    if (localItem.status === 'PENDING' && item.status !== 'PENDING') {
                        mergedMap.set(item.id, item);
                    } else if (localItem.status === 'PENDING' && item.status === 'PENDING') {
                        if (item.notified1to1) localItem.notified1to1 = true;
                        if (item.isBreakEven) localItem.isBreakEven = true;
                        if (item.sl !== undefined) localItem.sl = item.sl;
                    }
                }
            }
        });
        // 轉回陣列並依照 id (時間戳記) 從大到小排序，且限制最多 100 筆紀錄
        return Array.from(mergedMap.values()).sort((a, b) => b.id - a.id).slice(0, 100);
    }

    initTelegramConfig() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_telegram_config_${email}`;
        let config = {};
        try {
            config = JSON.parse(localStorage.getItem(configKey) || '{}');
        } catch (e) {
            config = {};
        }

        const tokenInput = document.getElementById('telegram-token');
        const chatIdInput = document.getElementById('telegram-chat-id');
        if (tokenInput) tokenInput.value = config.telegramToken || '';
        if (chatIdInput) chatIdInput.value = config.telegramChatId || '';
    }

    settlePaperTrade(record, finalStatus) {
        if (!this.currentUser || record.settledBalance) return;
        const email = this.currentUser.email;

        // 如果是歷史舊紀錄沒有 paperBalanceAtOpen 欄位，fallback 使用當前 paperBalance
        const paperBalanceAtOpen = record.paperBalanceAtOpen !== undefined ? record.paperBalanceAtOpen : this.paperBalance;
        
        // 增加安全防禦：防止帳戶餘額為負數或零時，導致收益與摩擦成本計算變為負數
        const baseBalance = paperBalanceAtOpen > 0 ? paperBalanceAtOpen : 10000.0;
        
        let pnlR = -1.0;
        if (finalStatus === 'TP') {
            pnlR = record.rr || 1.5;
        } else if (finalStatus === 'SL') {
            pnlR = record.isBreakEven ? 0.0 : -1.0;
        } else if (finalStatus === 'CLOSED') {
            pnlR = record.pnlR !== undefined ? record.pnlR : 0.0;
        }

        const feeRate = record.feeRate !== undefined ? record.feeRate : (this.strategyConfig.feeRate !== undefined ? this.strategyConfig.feeRate : 0.05);
        const slippage = record.slippage !== undefined ? record.slippage : (this.strategyConfig.slippage !== undefined ? this.strategyConfig.slippage : 0.02);
        const slPercent = record.slPercent !== undefined ? record.slPercent : (record.entry && record.sl ? (Math.abs(record.entry - record.sl) / record.entry) * 100 : 0);
        const frictionR = slPercent > 0 ? (2 * (feeRate + slippage) / slPercent) : 0;
        const actualPnLR = pnlR - frictionR;

        const profit = baseBalance * 0.02 * actualPnLR;
        this.paperBalance = parseFloat(this.paperBalance) + profit;
        localStorage.setItem(`snr_paper_balance_${email}`, this.paperBalance);

        record.settledBalance = true;
        record.realizedProfit = profit;
        record.frictionCost = baseBalance * 0.02 * frictionR;
        record.frictionR = frictionR;
    }

    initPaperAccount() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const balanceKey = `snr_paper_balance_${email}`;
        
        let localBalance = localStorage.getItem(balanceKey);
        if (localBalance !== null && !isNaN(parseFloat(localBalance))) {
            this.paperBalance = parseFloat(localBalance);
        } else {
            this.paperBalance = 10000.0;
            localStorage.setItem(balanceKey, this.paperBalance);
        }

        // 綁定重置按鈕事件
        const resetBtn = document.getElementById('reset-paper-account-btn');
        if (resetBtn) {
            resetBtn.onclick = () => this.resetPaperAccount();
        }

        this.updatePaperAccountUI();
    }

    updatePaperAccountUI() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 1. 計算未實現盈虧與已實現盈虧
        let unrealizedPnL = 0.0;
        let realizedPnL = 0.0;
        let activeMargin = 0.0;

        history.forEach(r => {
            if (r.status === 'PENDING') {
                if (r.paperBalanceAtOpen !== undefined && r.slPercent !== undefined) {
                    const margin = r.margin !== undefined ? r.margin : (r.paperBalanceAtOpen * 2 / (this.strategyConfig.riskRatio || 30));
                    const paperBalanceAtOpen = r.paperBalanceAtOpen;

                    activeMargin += margin;

                    if (r.currentPrice !== undefined) {
                        const initialSl = r.initialSl !== undefined ? r.initialSl : r.sl;
                        const risk = Math.abs(r.entry - initialSl);
                        const pnlR = risk > 0 ? (r.type === 'LONG'
                            ? (r.currentPrice - r.entry) / risk
                            : (r.entry - r.currentPrice) / risk) : 0.0;
                        unrealizedPnL += paperBalanceAtOpen * 0.02 * pnlR;
                    }
                }
            } else if (r.settledBalance && r.realizedProfit !== undefined) {
                realizedPnL += r.realizedProfit;
            }
        });

        const totalEquity = this.paperBalance + unrealizedPnL;
        const availableBalance = Math.max(0, this.paperBalance - activeMargin);

        // 2. 更新 DOM 元素
        const equityEl = document.getElementById('paper-account-equity');
        const unrealizedEl = document.getElementById('paper-account-unrealized');
        const realizedEl = document.getElementById('paper-account-realized');
        const balanceEl = document.getElementById('paper-account-balance');

        if (equityEl) equityEl.innerText = `${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
        if (balanceEl) balanceEl.innerText = `${availableBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

        if (unrealizedEl) {
            unrealizedEl.innerText = `${unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
            if (unrealizedPnL > 0) {
                unrealizedEl.style.color = '#0ecb81';
            } else if (unrealizedPnL < 0) {
                unrealizedEl.style.color = '#f6465d';
            } else {
                unrealizedEl.style.color = 'var(--text-muted)';
            }
        }

        if (realizedEl) {
            realizedEl.innerText = `${realizedPnL >= 0 ? '+' : ''}${realizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
            if (realizedPnL > 0) {
                realizedEl.style.color = '#0ecb81';
            } else if (realizedPnL < 0) {
                realizedEl.style.color = '#f6465d';
            } else {
                realizedEl.style.color = 'var(--text-muted)';
            }
        }
    }

    async resetPaperAccount() {
        if (!this.currentUser) return;
        if (!confirm('確定要將模擬帳戶重置為 10,000.00 USDT 嗎？\n這將會清除您所有的模擬交易與歷史分析紀錄！')) return;

        const email = this.currentUser.email;
        this.paperBalance = 10000.0;
        localStorage.setItem(`snr_paper_balance_${email}`, this.paperBalance);
        localStorage.setItem(`snr_history_${email}`, JSON.stringify([]));

        alert('模擬帳戶與歷史紀錄重置成功！');
        
        this.updatePaperAccountUI();
        this.renderHistory(false);
        await this.syncToCloud(true);
    }

    initStrategyConfig() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_strategy_config_${email}`;
        let config = { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
        try {
            const localConfig = localStorage.getItem(configKey);
            if (localConfig) {
                config = JSON.parse(localConfig);
            }
        } catch (e) {
            config = { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
        }

        this.strategyConfig = {
            emaPeriod: config.emaPeriod || 50,
            atrMultiplier: config.atrMultiplier || 1.5,
            riskRatio: config.riskRatio || 30,
            feeRate: config.feeRate !== undefined ? config.feeRate : 0.05,
            slippage: config.slippage !== undefined ? config.slippage : 0.02
        };

        const emaInput = document.getElementById('strategy-ema-period');
        const atrInput = document.getElementById('strategy-atr-multiplier');
        const riskInput = document.getElementById('strategy-risk-ratio');
        const feeInput = document.getElementById('strategy-fee-rate');
        const slippageInput = document.getElementById('strategy-slippage');

        if (emaInput) emaInput.value = this.strategyConfig.emaPeriod;
        if (atrInput) atrInput.value = this.strategyConfig.atrMultiplier;
        if (riskInput) riskInput.value = this.strategyConfig.riskRatio;
        if (feeInput) feeInput.value = this.strategyConfig.feeRate;
        if (slippageInput) slippageInput.value = this.strategyConfig.slippage;

        // 同步槓桿計算器的虧損比例
        const lossRatioEl = document.getElementById('calc-loss-ratio');
        if (lossRatioEl) {
            lossRatioEl.value = this.strategyConfig.riskRatio;
            this.calculateLeverage();
        }
    }


    toggleBlacklistConfig() {
        const content = document.getElementById('blacklist-config-content');
        const arrow = document.getElementById('blacklist-config-arrow');
        if (content && arrow) {
            content.classList.toggle('hidden');
            if (content.classList.contains('hidden')) {
                arrow.style.transform = 'rotate(0deg)';
            } else {
                arrow.style.transform = 'rotate(180deg)';
                // 展開後自動滾動到內容區域，讓使用者看到展開結果
                setTimeout(() => content.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
            }
        }
    }

    initBlacklistConfig() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_blacklist_config_${email}`;
        try {
            const saved = localStorage.getItem(configKey);
            if (saved) {
                this.customBlacklist = JSON.parse(saved);
            }
        } catch (e) {
            this.customBlacklist = [];
        }
        this.renderCustomBlacklistTags();
    }

    renderCustomBlacklistTags() {
        const container = document.getElementById('custom-blacklist-tags');
        if (!container) return;
        
        if (!this.customBlacklist || this.customBlacklist.length === 0) {
            container.innerHTML = `<span style="font-size: 12px; color: var(--text-muted);">尚未新增自訂排除幣種。</span>`;
            return;
        }

        let html = '';
        this.customBlacklist.forEach(symbol => {
            html += `<span style="background: rgba(0, 198, 255, 0.15); border: 1px solid rgba(0, 198, 255, 0.3); color: #00c6ff; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
                ${symbol}
                <span onclick="app.removeBlacklistSymbol('${symbol}')" style="cursor: pointer; font-size: 14px; line-height: 1; color: rgba(255,255,255,0.7); font-weight: bold;">&times;</span>
            </span>`;
        });
        container.innerHTML = html;
    }

    async addBlacklistSymbol() {
        const inputEl = document.getElementById('blacklist-input');
        if (!inputEl) return;
        
        let rawVal = inputEl.value.trim().toUpperCase().replace('/', '');
        if (!rawVal) {
            alert('請輸入欲排除的幣種名稱！');
            return;
        }

        // 自動補全 USDT
        if (!rawVal.endsWith('USDT')) {
            rawVal += 'USDT';
        }

        const defaultBlacklist = ['RLUSDUSDT', 'RLUSD', 'FDUSDUSDT', 'FDUSD', 'UUSDT', 'TRXUSDT'];
        if (defaultBlacklist.includes(rawVal) || rawVal.includes('RLUSD') || rawVal.includes('FDUSD')) {
            alert('該幣種屬於系統預設已被去除的標的，無須重複新增！');
            inputEl.value = '';
            return;
        }

        if (this.customBlacklist.includes(rawVal)) {
            alert(`幣種 ${rawVal} 已存在於您的自訂排除名單中！`);
            inputEl.value = '';
            return;
        }

        const addBtn = document.getElementById('add-blacklist-btn');
        const origText = addBtn ? addBtn.innerText : '';
        if (addBtn) {
            addBtn.innerText = '🔍 幣安 API 驗證中...';
            addBtn.disabled = true;
        }

        try {
            // 向幣安 API 即時驗證該幣種交易對是否存在
            const verifyUrl = `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${rawVal}`;
            const res = await fetch(verifyUrl);
            if (!res.ok) {
                alert(`❌ 幣種驗證失敗：幣安 (Binance) 交易所不存在交易對「${rawVal}」，請確認名稱是否正確！`);
                return;
            }
            const data = await res.json();
            if (!data || !data.symbol) {
                alert(`❌ 幣種驗證失敗：無效的交易對「${rawVal}」！`);
                return;
            }

            // 驗證成功，加入黑名單
            this.customBlacklist.push(rawVal);
            this.renderCustomBlacklistTags();
            inputEl.value = '';
            alert(`✅ 驗證成功！已將 ${rawVal} 加入排除清單，請點擊「儲存黑名單至雲端」以完成同步！`);

        } catch (e) {
            console.error('Blacklist verification error:', e);
            alert(`❌ 網路驗證錯誤：無法連接幣安 API 驗證 ${rawVal}`);
        } finally {
            if (addBtn) {
                addBtn.innerText = origText;
                addBtn.disabled = false;
            }
        }
    }

    removeBlacklistSymbol(symbol) {
        this.customBlacklist = this.customBlacklist.filter(s => s !== symbol);
        this.renderCustomBlacklistTags();
    }

    saveBlacklistConfig() {
        if (!this.currentUser) {
            alert('請先登入帳戶再儲存黑名單設定！');
            return;
        }

        const email = this.currentUser.email;
        const configKey = `snr_blacklist_config_${email}`;
        
        localStorage.setItem(configKey, JSON.stringify(this.customBlacklist));

        alert('🎉 黑名單設定已成功儲存！已直接上傳同步至 Firebase 雲端！');
        this.syncToCloud();
    }

    toggleStrategyConfig() {
        const content = document.getElementById('strategy-config-content');
        const arrow = document.getElementById('strategy-config-arrow');
        if (content && arrow) {
            content.classList.toggle('hidden');
            if (content.classList.contains('hidden')) {
                arrow.style.transform = 'rotate(0deg)';
            } else {
                arrow.style.transform = 'rotate(180deg)';
            }
        }
    }

    saveStrategyConfig() {
        if (!this.currentUser) {
            alert('請先登入帳戶再儲存設定');
            return;
        }

        const emaPeriodVal = document.getElementById('strategy-ema-period').value.trim();
        const atrMultiplierVal = document.getElementById('strategy-atr-multiplier').value.trim();
        const riskRatioVal = document.getElementById('strategy-risk-ratio').value.trim();
        const feeRateVal = document.getElementById('strategy-fee-rate').value.trim();
        const slippageVal = document.getElementById('strategy-slippage').value.trim();

        const emaPeriod = parseInt(emaPeriodVal);
        const atrMultiplier = parseFloat(atrMultiplierVal);
        const riskRatio = parseInt(riskRatioVal);
        const feeRate = parseFloat(feeRateVal);
        const slippage = parseFloat(slippageVal);

        if (isNaN(emaPeriod) || emaPeriod < 5 || emaPeriod > 300) {
            alert('EMA 週期必須是 5 到 300 之間的整數');
            return;
        }
        if (isNaN(atrMultiplier) || atrMultiplier < 0.1 || atrMultiplier > 10.0) {
            alert('ATR 止損倍數必須是 0.1 到 10.0 之間的數值');
            return;
        }
        if (isNaN(riskRatio) || riskRatio < 5 || riskRatio > 100) {
            alert('預設風險比例必須是 5% 到 100% 之間的整數');
            return;
        }
        if (isNaN(feeRate) || feeRate < 0.0 || feeRate > 1.0) {
            alert('交易手續費率必須是 0% 到 1% 之間的數值');
            return;
        }
        if (isNaN(slippage) || slippage < 0.0 || slippage > 2.0) {
            alert('預期滑價比例必須是 0% 到 2% 之間的數值');
            return;
        }

        const email = this.currentUser.email;
        const configKey = `snr_strategy_config_${email}`;
        
        this.strategyConfig = {
            emaPeriod,
            atrMultiplier,
            riskRatio,
            feeRate,
            slippage
        };

        localStorage.setItem(configKey, JSON.stringify(this.strategyConfig));

        // 更新槓桿預期虧損輸入框的預設值
        const lossRatioEl = document.getElementById('calc-loss-ratio');
        if (lossRatioEl) {
            lossRatioEl.value = riskRatio;
            this.calculateLeverage();
        }

        alert('策略設定儲存成功！並已同步至雲端。');
        this.syncToCloud();

        // 重新執行分析以套用新參數
        this.fetchAndAnalyze();
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

    saveTelegramConfig() {
        if (!this.currentUser) {
            alert('請先登入帳戶再儲存設定');
            return;
        }

        const telegramToken = document.getElementById('telegram-token').value.trim();
        const telegramChatId = document.getElementById('telegram-chat-id').value.trim();

        if (!telegramToken || !telegramChatId) {
            alert('請填寫 Telegram Bot Token 與 Chat ID');
            return;
        }

        const email = this.currentUser.email;
        const configKey = `snr_telegram_config_${email}`;
        
        const config = {
            telegramToken,
            telegramChatId
        };

        localStorage.setItem(configKey, JSON.stringify(config));

        alert('Telegram 通知設定儲存成功！並已同步至雲端。');
        this.syncToCloud();
    }

    async sendTestTelegramNotification() {
        if (!this.currentUser) {
            alert('請先登入帳戶再測試發送');
            return;
        }

        const telegramToken = document.getElementById('telegram-token').value.trim();
        const telegramChatId = document.getElementById('telegram-chat-id').value.trim();

        if (!telegramToken || !telegramChatId) {
            alert('請完整填寫 Telegram Bot Token 與 Chat ID 再進行測試。');
            return;
        }

        const testBtn = document.getElementById('test-tg-btn');
        testBtn.innerText = '發送中...';
        testBtn.disabled = true;

        try {
            const corsProxy = 'https://corsproxy.io/?';
            const targetUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            const proxyUrl = corsProxy + targetUrl;
            
            const messageText = `【SNR TRACER】測試發送\n您好，這是一條來自 SNR TRACER 策略分析儀的 Telegram 測試通知！\n\n當前您的 Telegram Bot 設定正確無誤。當自動掃描偵測到符合條件的交易機會時，您將會立刻收到通知。\n\n發送時間：${new Date().toLocaleString()}`;

            const response = await fetch(proxyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text: messageText
                })
            });

            if (response.ok) {
                alert('Telegram 測試通知發送成功！請檢查您的 Telegram 聊天室。');
            } else {
                const errText = await response.text();
                let friendlyMsg = `發送失敗，狀態碼: ${response.status}，訊息: ${errText}`;
                if (errText.includes("chat not found")) {
                    friendlyMsg += `\n\n💡 排除提示：\n1. 請確認您已在 Telegram 搜尋並點開您的機器人，並點擊了底部的「開始 (Start)」按鈕以啟動對話。\n2. 請確認 Chat ID 填寫的是您的個人數字 ID（可透過 @userinfobot 取得），而非 Telegram 使用者名稱。`;
                }
                alert(friendlyMsg);
            }
        } catch (error) {
            console.error('Telegram test notification failed:', error);
            alert(`測試發送失敗: ${error.message || error}`);
        } finally {
            testBtn.innerText = '測試 Telegram 發送';
            testBtn.disabled = false;
        }
    }

    formatCountdownTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    toggleAutoScan() {
        const btn = document.getElementById('auto-scan-btn');
        if (!btn) return;

        if (this.autoScanCountdownTimer) {
            // 目前為開啟狀態，點選以關閉
            clearInterval(this.autoScanCountdownTimer);
            this.autoScanCountdownTimer = null;
            this.autoScanSecondsLeft = 0;

            btn.innerText = '開啟自動分析';
            btn.style.background = 'rgba(255, 255, 255, 0.08)';
            btn.style.borderColor = 'var(--glass-border)';
            btn.style.color = 'var(--text-main)';

            this.showNotification('ℹ️ 自動分析已關閉', '系統已停止背景每 20 分鐘的定時雷達掃描。');
        } else {
            // 目前為關閉狀態，點選以開啟
            if (!this.currentUser) {
                this.showNotification('ℹ️ 未登入提示', '您目前尚未登入，自動分析可正常運行與倒數，但不會發送信箱通知。');
            } else if (this.currentUser.isGuest) {
                this.showNotification('ℹ️ 訪客模式提醒', '您目前以訪客身分體驗，自動分析可正常運行與倒數，但不會發送信箱通知。');
            }

            this.autoScanSecondsLeft = 20 * 60; // 20 分鐘
            btn.innerText = `自動分析中 (${this.formatCountdownTime(this.autoScanSecondsLeft)})`;
            btn.style.background = 'rgba(14, 203, 129, 0.1)';
            btn.style.borderColor = '#0ecb81';
            btn.style.color = '#0ecb81';

            this.showNotification('🚀 自動分析已開啟', '系統已啟動每 20 分鐘的雷達掃描。即將進行第一次分析...');
            
            // 立即執行一次分析
            this.scanMarket();

            // 啟動每秒計時器
            this.autoScanCountdownTimer = setInterval(() => {
                this.autoScanSecondsLeft--;
                if (this.autoScanSecondsLeft <= 0) {
                    btn.innerText = '自動分析中 (更新中...)';
                    // 執行掃描
                    this.scanMarket();
                    // 重置秒數
                    this.autoScanSecondsLeft = 20 * 60;
                } else {
                    btn.innerText = `自動分析中 (${this.formatCountdownTime(this.autoScanSecondsLeft)})`;
                }
            }, 1000);
        }
    }

    async sendTelegramNotification(newOpps) {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const configKey = `snr_telegram_config_${email}`;
        
        let config = {};
        try {
            config = JSON.parse(localStorage.getItem(configKey) || '{}');
        } catch (e) {
            return;
        }

        const { telegramToken, telegramChatId } = config;
        
        // 如果設定不完整，靜默跳過發送，只在控制台輸出
        if (!telegramToken || !telegramChatId) {
            console.log('Telegram 設定不完整，跳過通知發送');
            return;
        }

        try {
            const corsProxy = 'https://corsproxy.io/?';
            const targetUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
            const proxyUrl = corsProxy + targetUrl;

            // 格式化新發現的機會清單
            let messageText = `【SNR TRACER】雷達發現 ${newOpps.length} 個交易機會！\n\n`;
            messageText += `雷達週期：${this.interval.toUpperCase()}\n\n`;
            messageText += `【新交易機會清單】:\n`;
            
            newOpps.forEach((opp, i) => {
                const cleanSym = opp.symbol.replace('USDT', '');
                const dir = opp.signal === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
                
                // 計算建議槓桿
                const slPercent = (Math.abs(opp.lastPrice - opp.sl) / opp.lastPrice) * 100;
                const riskRatio = this.strategyConfig ? (this.strategyConfig.riskRatio || 30) : 30;
                let leverageVal = riskRatio / slPercent;
                let leverageStr = leverageVal > 125 ? `125x (超限)` : `${Math.round(leverageVal)}x`;

                if (opp.replaceOld) {
                    const oldDirStr = opp.oldType === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
                    const oldIntStr = opp.oldInterval ? ` ${opp.oldInterval.toUpperCase()}` : '';
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 勝率: ${(opp.winRate * 100).toFixed(0)}% 🔄\n`;
                    messageText += `   • 進場現價: $${this.formatPrice(opp.lastPrice)}\n`;
                    messageText += `   • 建議止盈: $${this.formatPrice(opp.tp)} | 建議止損: $${this.formatPrice(opp.sl)}\n`;
                    messageText += `   • 建議槓桿: ${leverageStr} (依 ${riskRatio}% 風險估算)\n`;
                    messageText += `   ⚠️ 說明：此機會之預估勝率優於您進行中的舊交易（舊信號: ${oldDirStr}${oldIntStr}，進場價: $${this.formatPrice(opp.oldEntry)}，舊勝率: ${(opp.oldWinRate * 100).toFixed(0)}%），系統已自動為您將舊交易【平倉】並替換為此新機會！\n\n`;
                } else {
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 預估勝率: ${(opp.winRate * 100).toFixed(0)}% | 盈虧比: ${opp.rr.toFixed(2)}\n`;
                    messageText += `   • 進場現價: $${this.formatPrice(opp.lastPrice)}\n`;
                    messageText += `   • 建議止盈: $${this.formatPrice(opp.tp)} | 建議止損: $${this.formatPrice(opp.sl)}\n`;
                    messageText += `   • 建議槓桿: ${leverageStr} (依 ${riskRatio}% 風險估算)\n\n`;
                }
            });

            messageText += `請儘速前往平台查看詳情與設定防守點位！\n`;
            messageText += `連結：https://spontaneous-kheer-c470e5.netlify.app/`;

            const response = await fetch(proxyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text: messageText
                })
            });

            if (response.ok) {
                console.log('交易機會 Telegram 通知發送成功！');
            } else {
                const errText = await response.text();
                console.warn('交易機會 Telegram 通知發送失敗，狀態碼:', response.status, '錯誤:', errText);
            }
        } catch (error) {
            console.error('發送機會 Telegram 通知出錯:', error);
        }
    }

    startPriceAutoUpdateTimer() {
        if (this.priceUpdateTimer) {
            clearInterval(this.priceUpdateTimer);
            this.priceUpdateTimer = null;
        }

        // 背景每 60 秒自動更新一次所有 PENDING 持倉的即時價格與結算狀態，並與雲端進行雙向同步
        this.priceUpdateTimer = setInterval(async () => {
            if (!this.currentUser) return;
            try {
                console.log('背景自動更新即時價格與持倉狀態中...');
                await this.checkHistorySettlement();
                await this.syncToCloud(); // 自動拉取與合併雲端新增的交易機會，防範網頁開啟時產生的覆蓋問題
                
                // 如果目前處於模擬收益曲線分頁，同步更新相關圖表 UI
                const activeTab = document.querySelector('.tab-btn.active');
                if (activeTab && activeTab.dataset.tab === 'equity-curve-tab') {
                    this.updateEquityCurveTab();
                    this.updatePaperAccountUI();
                }
            } catch (err) {
                console.error('背景自動更新價格出錯:', err);
            }
        }, 60 * 1000);
    }

    stopPriceAutoUpdateTimer() {
        if (this.priceUpdateTimer) {
            clearInterval(this.priceUpdateTimer);
            this.priceUpdateTimer = null;
        }
    }

    // ================= 一鍵匯出回測與交易明細報告 (Export Performance Reports) =================

    // 匯出歷史分析紀錄為 CSV 檔案
    exportHistoryCSV() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 讀取當前的篩選條件
        const filterDirSelect = document.getElementById('history-filter-direction');
        const filterIntervalSelect = document.getElementById('history-filter-interval');
        const filterStatusSelect = document.getElementById('history-filter-status');
        
        const selectedDir = filterDirSelect ? filterDirSelect.value : 'ALL';
        const selectedInterval = filterIntervalSelect ? filterIntervalSelect.value : 'ALL';
        const selectedStatus = filterStatusSelect ? filterStatusSelect.value : 'ALL';

        let filteredHistory = history.filter(r => {
            const dirMatch = selectedDir === 'ALL' || r.type === selectedDir;
            const intervalMatch = selectedInterval === 'ALL' || r.interval === selectedInterval;
            const statusMatch = selectedStatus === 'ALL' || r.status === selectedStatus;
            return dirMatch && intervalMatch && statusMatch;
        });

        if (filteredHistory.length === 0) {
            alert('目前沒有符合篩選條件的歷史分析紀錄可供匯出。');
            return;
        }

        // 欄位定義
        const headers = ['時間 (Time)', '交易對 (Symbol)', '週期 (Interval)', '方向 (Type)', '進場價 (Entry)', '建議止盈 (TP)', '建議止損 (SL)', '盈虧比 (R:R)', '勝率 (WinRate)', '狀態 (Status)', '實現盈虧 (Profit USDT)'];
        
        let csvContent = '\uFEFF'; // UTF-8 BOM 避免 Excel 開啟中文亂碼
        csvContent += headers.join(',') + '\n';

        filteredHistory.forEach(r => {
            const statusStr = r.status === 'PENDING' ? '進行中 (PENDING)' :
                              r.status === 'TP' ? '已止盈 (TP)' :
                              r.status === 'SL' ? '已止損 (SL)' :
                              r.status === 'CLOSED' ? '已平倉 (CLOSED)' : r.status;
            
            const realizedProfit = r.realizedProfit !== undefined ? r.realizedProfit.toFixed(2) : '0.00';
            const winRateStr = r.winRate !== undefined ? `${(r.winRate * 100).toFixed(0)}%` : '50%';

            const row = [
                r.timeStr,
                r.symbol,
                r.interval.toUpperCase(),
                r.type,
                r.entry,
                r.tp,
                r.sl,
                r.rr ? r.rr.toFixed(2) : '1.50',
                winRateStr,
                statusStr,
                realizedProfit
            ];
            csvContent += row.join(',') + '\n';
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10);
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `SNR_History_Report_${dateStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 匯出歷史回測明細為 CSV 檔案
    exportBacktestCSV() {
        const trades = this.lastBacktestTrades || [];
        if (trades.length === 0) {
            alert('目前沒有歷史回測數據可供匯出。請先執行一次歷史回測。');
            return;
        }

        const headers = ['代號 (Symbol)', '方向 (Direction)', '進場時間 (Open Time)', '出場時間 (Close Time)', '進場價 (Entry)', '出場價 (Close Price)', '預估勝率 (WinRate)', '盈虧比 (R:R)', '結果 (Status)', 'R值盈虧 (PnL)'];
        let csvContent = '\uFEFF'; // UTF-8 BOM
        csvContent += headers.join(',') + '\n';

        trades.forEach(t => {
            const formatTime = (ts) => {
                const date = new Date(ts);
                return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
            };

            const dirStr = t.direction === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
            const statusStr = t.status === 'TP' ? '已止盈 (TP)' :
                              t.status === 'SL' ? '已止損 (SL)' :
                              t.status === 'CLOSED' ? '已平倉 (CLOSED)' : t.status;
            const winRateStr = t.winRate !== undefined ? `${(t.winRate * 100).toFixed(0)}%` : '50%';

            const row = [
                t.symbol,
                dirStr,
                formatTime(t.openTime),
                formatTime(t.closeTime),
                t.entry,
                t.closePrice,
                winRateStr,
                t.rr ? t.rr.toFixed(2) : '1.50',
                statusStr,
                `${t.pnl.toFixed(2)} R`
            ];
            csvContent += row.join(',') + '\n';
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10);
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `SNR_Backtest_Report_${dateStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 匯出歷史分析紀錄為 PDF 報告
    async exportHistoryPDF() {
        if (!this.currentUser) return;
        const email = this.currentUser.email;
        const historyKey = `snr_history_${email}`;
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            history = [];
        }

        // 讀取當前的篩選狀態
        const filterDirSelect = document.getElementById('history-filter-direction');
        const filterIntervalSelect = document.getElementById('history-filter-interval');
        const filterStatusSelect = document.getElementById('history-filter-status');
        
        const selectedDir = filterDirSelect ? filterDirSelect.value : 'ALL';
        const selectedInterval = filterIntervalSelect ? filterIntervalSelect.value : 'ALL';
        const selectedStatus = filterStatusSelect ? filterStatusSelect.value : 'ALL';

        let filteredHistory = history.filter(r => {
            const dirMatch = selectedDir === 'ALL' || r.type === selectedDir;
            const intervalMatch = selectedInterval === 'ALL' || r.interval === selectedInterval;
            const statusMatch = selectedStatus === 'ALL' || r.status === selectedStatus;
            return dirMatch && intervalMatch && statusMatch;
        });

        if (filteredHistory.length === 0) {
            alert('目前沒有符合篩選條件的交易紀錄，無法生成 PDF 績效報告。');
            return;
        }

        // 收集統計資訊
        const total = filteredHistory.length;
        const settled = filteredHistory.filter(r => r.status === 'TP' || r.status === 'SL' || r.status === 'CLOSED');
        
        let winCount = 0;
        let lossCount = 0;
        let totalPnL = 0.0;
        
        settled.forEach(r => {
            let pnl = 0.0;
            if (r.status === 'TP') {
                pnl = r.rr || 1.5;
                winCount++;
            } else if (r.status === 'SL') {
                pnl = r.isBreakEven ? 0.0 : -1.0;
                lossCount++;
            } else if (r.status === 'CLOSED') {
                if (r.realizedProfit !== undefined && r.paperBalanceAtOpen) {
                    pnl = r.realizedProfit / (r.paperBalanceAtOpen * 0.02);
                } else {
                    pnl = -1.0;
                }
                if (pnl > 0) winCount++;
                else if (pnl < 0) lossCount++;
            }
            totalPnL += pnl;
        });
        
        const winRate = settled.length > 0 ? `${((winCount / settled.length) * 100).toFixed(1)}%` : '--';
        
        const stats = {
            total: `${total} Positions`,
            winRate: winRate,
            pnl: `${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} R`,
            ratio: `${winCount} W / ${lossCount} L`
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        await this.generatePDFReport(
            'Paper Trading Account Performance Summary',
            stats,
            filteredHistory,
            'history-equity-chart',
            `SNR_PaperTrading_Report_${dateStr}.pdf`
        );
    }

    // 匯出歷史回測結果為 PDF 報告
    async exportBacktestPDF() {
        const trades = this.lastBacktestTrades || [];
        if (trades.length === 0) {
            alert('目前沒有歷史回測數據。請先執行一次歷史回測。');
            return;
        }

        // 收集統計資訊
        const total = trades.length;
        
        let winCount = 0;
        let lossCount = 0;
        let totalPnL = 0.0;
        
        trades.forEach(t => {
            totalPnL += t.pnl;
            if (t.status === 'TP') {
                winCount++;
            } else if (t.status === 'SL') {
                lossCount++;
            } else if (t.status === 'CLOSED') {
                if (t.pnl > 0) winCount++;
                else if (t.pnl < 0) lossCount++;
            }
        });
        
        const winRate = total > 0 ? `${((winCount / total) * 100).toFixed(1)}%` : '--';
        
        const stats = {
            total: `${total} Trades`,
            winRate: winRate,
            pnl: `${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} R`,
            ratio: `${winCount} W / ${lossCount} L`
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        await this.generatePDFReport(
            'Historical Backtesting Performance Summary',
            stats,
            trades,
            'backtest-equity-chart',
            `SNR_Backtest_Report_${dateStr}.pdf`
        );
    }

    // 通用 PDF 績效報告繪製與下載核心邏輯 (html2canvas + jsPDF)
    async generatePDFReport(title, stats, trades, chartElementId, fileName) {
        this.showLoader(true);
        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('p', 'mm', 'a4');
            
            // 擷取資金曲線圖
            const chartContainer = document.getElementById(chartElementId);
            if (!chartContainer) {
                alert('找不到圖表元素，無法生成報告。');
                this.showLoader(false);
                return;
            }
            
            // 使用 html2canvas 將圖表轉為圖片 (高解析度)
            const canvas = await html2canvas(chartContainer, {
                backgroundColor: '#12161a', // 配合原圖表深色科技背景，擷取下來最漂亮
                scale: 2,
                logging: false
            });
            const chartImgData = canvas.toDataURL('image/png');
            
            // PDF 頁面底色 (A4: 210 x 297 mm)
            doc.setFillColor(248, 250, 252); // slate 50
            doc.rect(0, 0, 210, 297, 'F');
            
            // 1. 頁首與深色背景列
            doc.setFillColor(30, 41, 59); // slate 800
            doc.rect(0, 0, 210, 25, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.text('SNR TRACER PERFORMANCE REPORT', 15, 16);
            
            const dateStr = new Date().toLocaleString('zh-TW', { hour12: false });
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(148, 163, 184); // slate 400
            doc.text(`Time: ${dateStr}`, 145, 16);
            
            // 下方彩色裝飾線
            doc.setFillColor(0, 198, 255); // 科技藍
            doc.rect(0, 25, 210, 2, 'F');
            
            // 2. 報告主標題與設定資訊
            doc.setTextColor(15, 23, 42); // slate 900
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(14);
            doc.text(title, 15, 40);
            
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(71, 85, 105); // slate 600
            doc.text(`Strategy Settings: ${this.strategyConfig.emaPeriod} EMA | ${this.strategyConfig.atrMultiplier}x ATR | Risk: ${this.strategyConfig.riskRatio}%`, 15, 46);
            
            // 3. 繪製 4 大數據 KPI 區塊 (2x2 排版)
            const drawKpiCard = (x, y, w, h, label, value, isHighlight = false) => {
                doc.setFillColor(255, 255, 255);
                // 邊框
                doc.setDrawColor(226, 232, 240); // slate 200
                doc.roundedRect(x, y, w, h, 2, 2, 'FD');
                
                // 左側彩色小裝飾條
                if (isHighlight) {
                    doc.setFillColor(16, 185, 129);
                } else {
                    doc.setFillColor(56, 139, 253);
                }
                doc.rect(x, y + 2, 1.5, h - 4, 'F');
                
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9);
                doc.setTextColor(100, 116, 139); // slate 505
                doc.text(label, x + 5, y + 6);
                
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(14);
                
                if (isHighlight) {
                    if (value.includes('-') || value.includes('Loss')) {
                        doc.setTextColor(239, 68, 68); // 紅
                    } else {
                        doc.setTextColor(16, 185, 129); // 綠
                    }
                } else {
                    doc.setTextColor(15, 23, 42);
                }
                doc.text(value, x + 5, y + 14);
            };
            
            const cardW = 43;
            const cardH = 20;
            const startY = 53;
            drawKpiCard(15, startY, cardW, cardH, 'Total Trades', stats.total || '0');
            drawKpiCard(63, startY, cardW, cardH, 'Win Rate', stats.winRate || '--');
            drawKpiCard(111, startY, cardW, cardH, 'Total PnL', stats.pnl || '0.00 R', true);
            drawKpiCard(159, startY, cardW, cardH, 'Profit / Loss', stats.ratio || '0 / 0');
            
            // 4. 插入資金曲線圖 (Equity Curve)
            doc.setFillColor(255, 255, 255);
            doc.roundedRect(15, 80, 180, 95, 2, 2, 'FD');
            
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(30, 41, 59);
            doc.text('Equity Curve Analysis', 20, 88);
            
            // 嵌入資金曲線 Canvas 擷取圖
            doc.addImage(chartImgData, 'PNG', 18, 92, 174, 80);
            
            // 5. 繪製精選亮點交易紀錄 (Top 5 Trades)
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(30, 41, 59);
            doc.text('Featured Performance Trades (Top 5 PnL)', 15, 188);
            
            // 繪製表格 Header
            const tableY = 194;
            doc.setFillColor(30, 41, 59);
            doc.rect(15, tableY, 180, 8, 'F');
            
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9);
            doc.setTextColor(255, 255, 255);
            doc.text('Symbol', 20, tableY + 5.5);
            doc.text('Type', 45, tableY + 5.5);
            doc.text('Entry Price', 70, tableY + 5.5);
            doc.text('Close Price', 105, tableY + 5.5);
            doc.text('Win Rate', 140, tableY + 5.5);
            doc.text('Return (PnL)', 170, tableY + 5.5);
            
            // 篩選出回報最好的前 5 筆交易
            const featuredTrades = [...trades]
                .filter(t => t.status !== 'PENDING')
                .sort((a, b) => {
                    const pnlA = a.pnl !== undefined ? a.pnl : (a.realizedProfit || 0);
                    const pnlB = b.pnl !== undefined ? b.pnl : (b.realizedProfit || 0);
                    return pnlB - pnlA; // 降序
                })
                .slice(0, 5);
                
            let rowY = tableY + 8;
            featuredTrades.forEach((t, index) => {
                if (index % 2 === 1) {
                    doc.setFillColor(241, 245, 249); // slate 100
                } else {
                    doc.setFillColor(255, 255, 255);
                }
                doc.rect(15, rowY, 180, 8, 'F');
                
                doc.setDrawColor(241, 245, 249);
                doc.line(15, rowY + 8, 195, rowY + 8);
                
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8.5);
                doc.setTextColor(51, 65, 85);
                
                const sym = t.symbol ? t.symbol.replace('USDT', '') : '';
                const typeStr = t.type || t.direction || 'LONG';
                const entryVal = t.entry || 0;
                const closeVal = t.closePrice || t.tp || 0;
                const winRateVal = t.winRate !== undefined ? `${(t.winRate * 100).toFixed(0)}%` : '--';
                
                let pnlVal = 0;
                let pnlTextStr = '';
                if (t.pnl !== undefined) {
                    pnlVal = t.pnl;
                    pnlTextStr = `${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)} R`;
                } else if (t.realizedProfit !== undefined) {
                    pnlVal = t.realizedProfit;
                    pnlTextStr = `${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}`;
                }
                
                doc.text(sym, 20, rowY + 5.5);
                doc.text(typeStr, 45, rowY + 5.5);
                doc.text(`$${this.formatPrice(entryVal)}`, 70, rowY + 5.5);
                doc.text(`$${this.formatPrice(closeVal)}`, 105, rowY + 5.5);
                doc.text(winRateVal, 140, rowY + 5.5);
                
                if (pnlVal > 0) {
                    doc.setTextColor(16, 185, 129); // 綠
                } else if (pnlVal < 0) {
                    doc.setTextColor(239, 68, 68); // 紅
                } else {
                    doc.setTextColor(100, 116, 139);
                }
                doc.text(pnlTextStr, 170, rowY + 5.5);
                
                rowY += 8;
            });
            
            if (featuredTrades.length === 0) {
                doc.setFillColor(255, 255, 255);
                doc.rect(15, rowY, 180, 15, 'F');
                doc.setTextColor(148, 163, 184);
                doc.text('No settled trade records available for comparison.', 65, rowY + 9);
            }
            
            // 6. 頁尾與浮水印
            doc.setFillColor(148, 163, 184);
            doc.line(15, 280, 195, 280);
            
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(148, 163, 184);
            doc.text('SNR TRACER - Agentic Quantitative Support System', 15, 285);
            doc.text('Page 1 of 1', 180, 285);
            
            doc.save(fileName);
            
        } catch (err) {
            console.error("PDF generation failed:", err);
            alert("PDF 績效報告生成失敗，請檢查瀏覽器主控台。");
        } finally {
            this.showLoader(false);
        }
    }
}



let app;
window.onload = () => {
    app = new SNRTracer();
};
