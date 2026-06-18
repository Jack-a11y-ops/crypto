/**
 * SNR TRACER - Node.js Cloud Radar Scanner
 * 用於 GitHub Actions 背景定時掃描，免依賴 (Zero-Dependency)
 * 透過 Firebase REST API 同步設定與歷史紀錄，並呼叫 EmailJS API 發送通知
 */

if (typeof fetch === 'undefined') {
    console.error('錯誤：本腳本需要 Node.js v18 或更高版本（支援原生 fetch）。請升級您的 Node.js 環境。');
    process.exit(1);
}

// 1. 環境變數檢測
const userEmail = process.env.USER_EMAIL;
if (!userEmail) {
    console.error('錯誤：找不到環境變數 USER_EMAIL。請在 GitHub Secrets 中配置您的登入電子信箱。');
    process.exit(1);
}

// 轉換為 Firebase 安全的路徑鍵值 (將點號替換為底線)
const safeEmail = userEmail.replace(/\./g, '_');
const rtdbUrl = `https://crypto-6536b-default-rtdb.firebaseio.com/users/${safeEmail}.json`;

// 格式化價格輔助函式
function formatPrice(price) {
    if (typeof price !== 'number') price = parseFloat(price);
    if (price >= 1000) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    if (price >= 0.1) return price.toFixed(5);
    if (price >= 0.01) return price.toFixed(6);
    return price.toFixed(8);
}

// 指數移動平均線 (EMA) 計算
function calculateEMA(data, period = 50) {
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

// 平均真實波幅 (ATR) 計算 (獲取最後一根 ATR 波動值)
function calculateLastATR(data, period = 14) {
    if (data.length < period) return 0;
    
    // 1. 計算 TR
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

    // 2. 初始 ATR
    let atr = 0;
    for (let i = 0; i < period; i++) {
        atr += trArr[i];
    }
    atr = atr / period;

    // 3. 滾動 ATR
    for (let i = period; i < data.length; i++) {
        atr = (atr * (period - 1) + trArr[i]) / period;
    }
    return atr;
}

// 核心 SNR 分析邏輯 (整合 EMA 趨勢與 ATR 波動度)
function analyzeSNR(data) {
    const lastPrice = data[data.length - 1].close;
    const ema50 = calculateEMA(data, 50);
    const lastEMA = ema50[ema50.length - 1];
    const prevEMA = ema50[ema50.length - 2];
    const lastATR = calculateLastATR(data, 14);

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
            const precisionAdd = Math.min(Math.max((1.5 - distRatio) * 0.04, -0.02), 0.06);
            winRate += precisionAdd;
        }
    } else {
        winRate = 0.0;
    }
    
    // 限制最終勝率在 35% ~ 75% 之間
    winRate = Math.min(Math.max(winRate, 0.35), 0.75);

    return { levels, support, resistance, signal, rr, sl, tp, lastATR, winRate };
}

// 主執行流程
async function run() {
    const taipeiTimeStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    console.log(`[${taipeiTimeStr}] 啟動 SNR 雷達雲端掃描，目標使用者: ${userEmail}...`);

    try {
        // 2. 獲取 Firebase 雲端資料 (設定、歷史紀錄、已通知列表)
        const dbResponse = await fetch(rtdbUrl);
        if (!dbResponse.ok) {
            throw new Error(`無法連接 Firebase 雲端資料庫, status: ${dbResponse.status}`);
        }
        
        const userData = await dbResponse.json();
        if (!userData) {
            console.error('錯誤：找不到使用者的雲端資料。請先在網頁端登入您的帳戶。');
            process.exit(1);
        }

        const emailConfig = userData.emailConfig || {};
        const { emailTarget, serviceId, templateId, publicKey } = emailConfig;

        if (!emailTarget || !serviceId || !templateId || !publicKey) {
            console.warn('警告：信箱通知設定不完整。請先於網頁端「全市場雷達掃描」分頁中填寫並儲存設定。');
            process.exit(0);
        }

        const interval = userData.lastInterval || '1h';
        let history = userData.history || [];
        let notified = userData.notified || {};

        console.log(`設定加載成功。掃描週期: ${interval.toUpperCase()} | 接收信箱: ${emailTarget}`);

        // 3. 獲取幣安前 50 大成交量 USDT 交易對
        console.log('正在從幣安獲取前 50 大成交量交易對...');
        const tickersResponse = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr');
        const tickers = await tickersResponse.json();
        
        if (!Array.isArray(tickers)) {
            console.error('錯誤：幣安 API 未回傳陣列格式。可能是被地理位置封鎖或超頻限制。返回內容：', JSON.stringify(tickers));
            process.exit(1);
        }

        const top50 = tickers
            .filter(t => t.symbol.endsWith('USDT'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, 50);

        const opportunities = [];

        // 4. 批量分析每個交易對
        for (const item of top50) {
            try {
                const klinesUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${item.symbol}&interval=${interval}&limit=150`;
                const klinesResponse = await fetch(klinesUrl);
                const klines = await klinesResponse.json();
                
                if (!Array.isArray(klines) || klines.length < 100) continue;

                const chartData = klines.map(d => ({
                    close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3])
                }));

                const lastPrice = chartData[chartData.length - 1].close;
                const analysis = analyzeSNR(chartData);

                if (analysis.signal !== 'WATCH' && analysis.rr > 1.0) {
                    opportunities.push({
                        symbol: item.symbol,
                        signal: analysis.signal,
                        rr: analysis.rr,
                        lastPrice: lastPrice,
                        support: analysis.support,
                        resistance: analysis.resistance,
                        sl: analysis.sl,
                        tp: analysis.tp,
                        winRate: analysis.winRate
                    });
                }
            } catch (e) {
                // 靜默跳過異常幣種
            }
        }

        console.log(`掃描完畢。共找到 ${opportunities.length} 個符合高盈虧比 (R:R > 1.0) 的交易信號。`);

        // 5. 去重篩選與重複交易判定
        const now = Date.now();
        const newOpportunities = [];

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
                } else {
                    // 舊交易較佳：維持舊交易，跳過新機會
                    console.log(`[${opp.symbol}] 舊交易 PENDING (${oldPending.interval.toUpperCase()}) 的 winRate (${(oldWinRate * 100).toFixed(0)}%) 優於或等於新機會 (${(newWinRate * 100).toFixed(0)}%)，維持舊交易。`);
                }
            } else {
                // 沒有同幣種同週期的 Pending 舊交易，維持原有 10 分鐘去重邏輯
                const key = `${opp.symbol}_${interval}_${opp.signal}`;
                const lastNotified = notified[key];
                
                if (!lastNotified || (now - lastNotified) > 10 * 60 * 1000) {
                    newOpportunities.push(opp);
                    notified[key] = now;
                }
            }
        });

        // 6. 如果有新機會，發送 Email 並同步更新歷史紀錄與已通知時間戳
        if (newOpportunities.length > 0) {
            console.log(`發現 ${newOpportunities.length} 個新機會！準備發送 Email 通知...`);

            // 6.1 格式化郵件內文 (強制採用台灣時間 GMT+8)
            const taipeiTimeStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
            let messageText = `親愛的 SNR TRACER 使用者，您好：\n\n系統已在雲端背景掃描中，偵測到符合條件的優質交易機會！\n\n偵測時間（台灣時間）：${taipeiTimeStr}\n\n`;
            messageText += `雷達週期：${interval.toUpperCase()}\n\n`;
            messageText += `【新交易機會清單】:\n`;
            
            newOpportunities.forEach((opp, i) => {
                const cleanSym = opp.symbol.replace('USDT', '');
                const dir = opp.signal === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
                
                if (opp.replaceOld) {
                    const oldDirStr = opp.oldType === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
                    const oldIntStr = opp.oldInterval ? ` ${opp.oldInterval.toUpperCase()}` : '';
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 勝率: ${(opp.winRate * 100).toFixed(0)}% 🔄\n`;
                    messageText += `   ⚠️ 說明：此機會之預估勝率優於您進行中的舊交易（舊信號: ${oldDirStr}${oldIntStr}，進場價: $${formatPrice(opp.oldEntry)}，舊勝率: ${(opp.oldWinRate * 100).toFixed(0)}%），系統已自動為您將舊交易【平倉】並替換為此新機會！\n\n`;
                } else {
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 預估勝率: ${(opp.winRate * 100).toFixed(0)}% | 盈虧比: ${opp.rr.toFixed(2)}\n\n`;
                }
                
                // 6.2 同步寫入歷史紀錄 (比照前端 saveToHistory)
                const tp = opp.tp;
                const sl = opp.sl;

                // 如果是替換舊交易，我們將舊交易的 status 標記為 CLOSED，並記錄平倉價格
                if (opp.replaceOld && opp.oldId) {
                    const oldRecord = history.find(r => r.id === opp.oldId);
                    if (oldRecord) {
                        oldRecord.status = 'CLOSED';
                        oldRecord.closePrice = opp.lastPrice; // 平倉價為新交易的 entry 價格 (即當前現價)
                    }
                }

                // 歷史紀錄防重複寫入 (如果是 replaceOld，則不需防重複檢查，直接寫入)
                const isDuplicate = opp.replaceOld ? false : history.some(item => 
                    item.symbol === opp.symbol && 
                    item.interval === interval && 
                    item.type === opp.signal && 
                    (now - item.id) < 3 * 60 * 1000
                );

                if (!isDuplicate) {
                    // 將時間轉換為台灣時區的年月日與時分秒，防範 GitHub Actions 伺服器時區誤差
                    const formatter = new Intl.DateTimeFormat('zh-TW', {
                        timeZone: 'Asia/Taipei',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    });
                    const parts = formatter.formatToParts(new Date(now));
                    const partMap = {};
                    parts.forEach(p => partMap[p.type] = p.value);
                    const timeStr = `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;

                    history.unshift({
                        id: now,
                        timeStr: timeStr,
                        symbol: opp.symbol,
                        interval: interval,
                        type: opp.signal,
                        entry: opp.lastPrice,
                        tp: tp,
                        sl: sl,
                        rr: opp.rr,
                        winRate: opp.winRate !== undefined ? opp.winRate : 0.50,
                        status: 'PENDING'
                    });
                }
            });

            messageText += `請儘速前往您的 SNR TRACER 平台查看詳情與設定防守點位！\n`;
            messageText += `網址：http://localhost:8000\n\n`;
            messageText += `*此信件為雲端自動發送，請勿直接回覆。`;

            // 6.3 限制歷史紀錄長度最長為 100 筆
            if (history.length > 100) {
                history = history.slice(0, 100);
            }

            // 6.4 發送 EmailJS REST API 請求
            const emailjsUrl = 'https://api.emailjs.com/api/v1.0/email/send';
            const emailParams = {
                service_id: serviceId,
                template_id: templateId,
                user_id: publicKey,
                template_params: {
                    to_email: emailTarget,
                    subject: `⚠️【SNR TRACER】雲端雷達發現 ${newOpportunities.length} 個新交易機會！`,
                    message: messageText
                }
            };

            // 如果存在 Private Key (嚴格模式)，則附加 accessToken 進行安全發信
            if (process.env.EMAILJS_PRIVATE_KEY) {
                emailParams.accessToken = process.env.EMAILJS_PRIVATE_KEY;
            }

            const emailResponse = await fetch(emailjsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emailParams)
            });

            if (emailResponse.ok) {
                console.log('Email 發送成功！');
            } else {
                const errText = await emailResponse.text();
                console.error(`Email 發送失敗，狀態碼: ${emailResponse.status}, 訊息: ${errText}`);
            }

            // 6.5 更新 Firebase 雲端資料 (包含 history 與 notified 機會列表)
            const patchResponse = await fetch(rtdbUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    history: history,
                    notified: notified,
                    updatedAt: { ".sv": "timestamp" }
                })
            });

            if (patchResponse.ok) {
                console.log('Firebase 雲端歷史紀錄與已通知時間戳更新成功！');
            } else {
                console.error(`Firebase 雲端更新失敗，狀態碼: ${patchResponse.status}`);
            }
        } else {
            console.log('無符合條件的新交易機會，或新機會已被過濾去重。跳過發信。');
        }

    } catch (error) {
        console.error('執行雲端掃描時出錯:', error);
    }
}

run();
