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

function calculateRSI(data, period = 14) {
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

function calculateMACD(data) {
    const ema12 = calculateEMA(data, 12);
    const ema26 = calculateEMA(data, 26);
    
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

// 核心 SNR 分析邏輯 (整合 EMA 趨勢、ATR 波動度、RSI與MACD多指標共振)
function analyzeSNR(data, config = null) {
    const activeConfig = config || { emaPeriod: 50, atrMultiplier: 1.5 };
    const emaPeriod = activeConfig.emaPeriod || 50;
    const atrMultiplier = activeConfig.atrMultiplier || 1.5;

    const lastPrice = data[data.length - 1].close;
    const emaVal = calculateEMA(data, emaPeriod);
    const lastEMA = emaVal[emaVal.length - 1];
    const prevEMA = emaVal[emaVal.length - 2];
    const lastATR = calculateLastATR(data, 14);

    // 多指標共振計算
    const rsiVal = calculateRSI(data, 14);
    const lastRSI = rsiVal[rsiVal.length - 1];
    const macdVal = calculateMACD(data);
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

async function checkCloudHistorySettlement(history, paperBalance, telegramToken, telegramChatId, riskRatio) {
    const pendingRecords = history.filter(r => r.status === 'PENDING');
    if (pendingRecords.length === 0) return { history, paperBalance, hasUpdates: false };

    let hasUpdates = false;
    const maxQueries = Math.min(pendingRecords.length, 5);
    
    for (let i = 0; i < maxQueries; i++) {
        const record = pendingRecords[i];
        try {
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

            for (let k = 0; k < klines.length; k++) {
                const klineOpenTime = klines[k][0];
                if (klineOpenTime + intervalMs < record.id) continue;

                const high = parseFloat(klines[k][2]);
                const low = parseFloat(klines[k][3]);

                const cleanSymbol = record.symbol.replace('USDT', '');

                // 1. 移動止損 (Break-even) 判定
                if (!record.isBreakEven) {
                    if (record.type === 'LONG') {
                        if (high >= record.entry + oneRSpace) {
                            record.sl = record.entry;
                            record.isBreakEven = true;
                            hasUpdates = true;

                            await sendCloudTelegramAlert(telegramToken, telegramChatId, 
                                `🛡️【移動止損保本警報】\n\n您的 ${cleanSymbol} ${record.type} 交易已獲利達到 1R 空間！\n\n系統已自動將該持倉之止損位（SL）修改為您的進場價：$${formatPrice(record.entry)}。\n當前該筆交易已鎖定零風險保本！`
                            );
                        }
                    } else if (record.type === 'SHORT') {
                        if (low <= record.entry - oneRSpace) {
                            record.sl = record.entry;
                            record.isBreakEven = true;
                            hasUpdates = true;

                            await sendCloudTelegramAlert(telegramToken, telegramChatId, 
                                `🛡️【移動止損保本警報】\n\n您的 ${cleanSymbol} ${record.type} 交易已獲利達到 1R 空間！\n\n系統已自動將該持倉之止損位（SL）修改為您的進場價：$${formatPrice(record.entry)}。\n當前該筆交易已鎖定零風險保本！`
                            );
                        }
                    }
                }

                // 2. TP / SL 結算判定
                if (record.type === 'LONG') {
                    if (low <= record.sl) {
                        record.status = 'SL';
                        const profit = settleCloudPaperTrade(record, 'SL', paperBalance);
                        paperBalance = parseFloat(paperBalance) + profit;
                        hasUpdates = true;

                        await sendCloudTelegramSettlementAlert(telegramToken, telegramChatId, record, 'SL', profit);
                        break;
                    }
                    if (high >= record.tp) {
                        record.status = 'TP';
                        const profit = settleCloudPaperTrade(record, 'TP', paperBalance);
                        paperBalance = parseFloat(paperBalance) + profit;
                        hasUpdates = true;

                        await sendCloudTelegramSettlementAlert(telegramToken, telegramChatId, record, 'TP', profit);
                        break;
                    }
                } else if (record.type === 'SHORT') {
                    if (high >= record.sl) {
                        record.status = 'SL';
                        const profit = settleCloudPaperTrade(record, 'SL', paperBalance);
                        paperBalance = parseFloat(paperBalance) + profit;
                        hasUpdates = true;

                        await sendCloudTelegramSettlementAlert(telegramToken, telegramChatId, record, 'SL', profit);
                        break;
                    }
                    if (low <= record.tp) {
                        record.status = 'TP';
                        const profit = settleCloudPaperTrade(record, 'TP', paperBalance);
                        paperBalance = parseFloat(paperBalance) + profit;
                        hasUpdates = true;

                        await sendCloudTelegramSettlementAlert(telegramToken, telegramChatId, record, 'TP', profit);
                        break;
                    }
                }
            }

            if (record.status === 'PENDING' && klines.length >= 500) {
                record.status = 'EXPIRED';
                hasUpdates = true;
            }

        } catch (err) {
            console.error(`Cloud check settlement error for ${record.symbol}:`, err);
        }
    }
    return { history, paperBalance, hasUpdates };
}

function settleCloudPaperTrade(record, finalStatus, currentPaperBalance) {
    if (record.settledBalance) return 0;
    const paperBalanceAtOpen = record.paperBalanceAtOpen !== undefined ? record.paperBalanceAtOpen : currentPaperBalance;
    
    let pnlR = -1.0;
    if (finalStatus === 'TP') {
        pnlR = record.rr || 1.5;
    } else if (finalStatus === 'SL') {
        pnlR = record.isBreakEven ? 0.0 : -1.0;
    }

    const profit = paperBalanceAtOpen * 0.02 * pnlR;
    record.settledBalance = true;
    record.realizedProfit = profit;
    return profit;
}

async function sendCloudTelegramAlert(token, chatId, text) {
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
        });
    } catch (e) {
        console.error('Send cloud telegram BE alert failed:', e);
    }
}

async function sendCloudTelegramSettlementAlert(token, chatId, record, status, profitUSDT) {
    if (!token || !chatId) return;
    const cleanSymbol = record.symbol.replace('USDT', '');
    const statusText = status === 'TP' ? '🎯【交易已成功止盈】' : '❌【交易已被止損出場】';
    const profitSign = profitUSDT >= 0 ? `+${profitUSDT.toFixed(2)}` : `${profitUSDT.toFixed(2)}`;
    
    let messageText = `${statusText}\n\n`;
    messageText += `交易對：${cleanSymbol}/USDT (${record.interval.toUpperCase()})\n`;
    messageText += `方向：${record.type}\n`;
    messageText += `進場價：$${formatPrice(record.entry)}\n`;
    messageText += `出場價：$${formatPrice(status === 'TP' ? record.tp : record.sl)}\n`;
    messageText += `實現盈虧：${profitSign} USDT\n\n`;
    messageText += `請前往平台查看您的模擬帳戶權益明細！\n`;
    messageText += `網址：https://spontaneous-kheer-c470e5.netlify.app/`;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: messageText })
        });
    } catch (e) {
        console.error('Send cloud telegram settlement alert failed:', e);
    }
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

        const telegramConfig = userData.telegramConfig || {};
        const { telegramToken, telegramChatId } = telegramConfig;

        if (!telegramToken || !telegramChatId) {
            console.warn('警告：Telegram 通知設定不完整。請先於網頁端「全市場雷達掃描」分頁中填寫並儲存設定。');
            process.exit(0);
        }

        const interval = userData.lastInterval || '1h';
        let history = userData.history || [];
        let notified = userData.notified || {};
        
        const strategyConfig = userData.strategyConfig || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30 };
        const emaPeriod = strategyConfig.emaPeriod || 50;
        const atrMultiplier = strategyConfig.atrMultiplier || 1.5;
        const riskRatio = strategyConfig.riskRatio || 30;
        let paperBalance = userData.paperBalance !== undefined ? parseFloat(userData.paperBalance) : 10000.0;

        // 執行持倉結算與移動止損判定
        const settlementResult = await checkCloudHistorySettlement(history, paperBalance, telegramToken, telegramChatId, riskRatio);
        history = settlementResult.history;
        paperBalance = settlementResult.paperBalance;
        let settlementUpdates = settlementResult.hasUpdates;

        console.log(`設定加載成功。掃描週期: ${interval.toUpperCase()} | Telegram Bot 已配置 | 策略參數: ${emaPeriod} EMA, ${atrMultiplier}x ATR, ${riskRatio}% 風險 | 虛擬餘額: ${paperBalance.toFixed(2)} USDT`);

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
                const analysis = analyzeSNR(chartData, strategyConfig);

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

        // 6. 如果有新機會，發送 Telegram 通知並同步更新歷史紀錄與已通知時間戳
        if (newOpportunities.length > 0) {
            console.log(`發現 ${newOpportunities.length} 個新機會！準備發送 Telegram 通知...`);

            // 6.1 格式化通知內文 (強制採用台灣時間 GMT+8)
            const taipeiTimeStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
            let messageText = `【SNR TRACER】雲端雷達發現交易機會！\n\n偵測時間（台灣時間）：${taipeiTimeStr}\n\n`;
            messageText += `雷達週期：${interval.toUpperCase()}\n\n`;
            messageText += `【新交易機會清單】:\n`;
            
            newOpportunities.forEach((opp, i) => {
                const cleanSym = opp.symbol.replace('USDT', '');
                const dir = opp.signal === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
                
                // 計算建議槓桿
                const slPercent = (Math.abs(opp.lastPrice - opp.sl) / opp.lastPrice) * 100;
                let leverageVal = riskRatio / slPercent;
                let leverageStr = leverageVal > 125 ? `125x (超限)` : `${Math.round(leverageVal)}x`;

                if (opp.replaceOld) {
                    const oldDirStr = opp.oldType === 'LONG' ? '買入 (LONG)' : '賣出 (SHORT)';
                    const oldIntStr = opp.oldInterval ? ` ${opp.oldInterval.toUpperCase()}` : '';
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 勝率: ${(opp.winRate * 100).toFixed(0)}% 🔄\n`;
                    messageText += `   • 進場現價: $${formatPrice(opp.lastPrice)}\n`;
                    messageText += `   • 建議止盈: $${formatPrice(opp.tp)} | 建議止損: $${formatPrice(opp.sl)}\n`;
                    messageText += `   • 建議槓桿: ${leverageStr} (依 ${riskRatio}% 風險估算)\n`;
                    messageText += `   ⚠️ 說明：此機會之預估勝率優於您進行中的舊交易（舊信號: ${oldDirStr}${oldIntStr}，進場價: $${formatPrice(opp.oldEntry)}，舊勝率: ${(opp.oldWinRate * 100).toFixed(0)}%），系統已自動為您將舊交易【平倉】並替換為此新機會！\n\n`;
                } else {
                    messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 預估勝率: ${(opp.winRate * 100).toFixed(0)}% | 盈虧比: ${opp.rr.toFixed(2)}\n`;
                    messageText += `   • 進場現價: $${formatPrice(opp.lastPrice)}\n`;
                    messageText += `   • 建議止盈: $${formatPrice(opp.tp)} | 建議止損: $${formatPrice(opp.sl)}\n`;
                    messageText += `   • 建議槓桿: ${leverageStr} (依 ${riskRatio}% 風險估算)\n\n`;
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
                        
                        if (!oldRecord.settledBalance) {
                            const oldPaperBalanceAtOpen = oldRecord.paperBalanceAtOpen !== undefined ? oldRecord.paperBalanceAtOpen : paperBalance;
                            const pnlR = oldRecord.type === 'LONG'
                                ? (opp.lastPrice - oldRecord.entry) / Math.abs(oldRecord.entry - oldRecord.sl)
                                : (oldRecord.entry - opp.lastPrice) / Math.abs(oldRecord.entry - oldRecord.sl);
                            const profit = oldPaperBalanceAtOpen * 0.02 * pnlR;
                            paperBalance = parseFloat(paperBalance) + profit;
                            oldRecord.settledBalance = true;
                            oldRecord.realizedProfit = profit;
                        }
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

                    const slPercent = (Math.abs(opp.lastPrice - sl) / opp.lastPrice) * 100;
                    const paperLeverage = riskRatio / slPercent;
                    const paperMargin = paperBalance * 0.02 / (riskRatio / 100);
                    const paperPositionValue = paperMargin * paperLeverage;

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
                        status: 'PENDING',
                        
                        // 模擬交易持倉數據快照
                        paperBalanceAtOpen: paperBalance,
                        slPercent: slPercent,
                        leverage: paperLeverage,
                        margin: paperMargin,
                        positionValue: paperPositionValue
                    });
                }
            });

            messageText += `請儘速前往您的 SNR TRACER 平台查看詳情與設定防守點位！\n`;
            messageText += `網址：https://spontaneous-kheer-c470e5.netlify.app/`;

            // 6.3 限制歷史紀錄長度最長為 100 筆
            if (history.length > 100) {
                history = history.slice(0, 100);
            }

            // 6.4 發送 Telegram Bot API 請求
            const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

            const tgResponse = await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: telegramChatId,
                    text: messageText
                })
            });

            if (tgResponse.ok) {
                console.log('Telegram 通知發送成功！');
            } else {
                const errText = await tgResponse.text();
                console.error(`Telegram 通知發送失敗，狀態碼: ${tgResponse.status}, 訊息: ${errText}`);
            }

            // 6.5 更新 Firebase 雲端資料 (包含 history 與 notified 機會列表)
            const patchResponse = await fetch(rtdbUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    history: history,
                    notified: notified,
                    paperBalance: paperBalance,
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
            
            // 如果沒有新機會，但有持倉結算或移動止損更新，依然需要 PATCH 同步回雲端
            if (settlementUpdates) {
                console.log('有持倉結算或移動止損更新，正在同步至雲端 Firebase...');
                await fetch(rtdbUrl, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        history: history,
                        paperBalance: paperBalance,
                        updatedAt: { ".sv": "timestamp" }
                    })
                });
            }
        }

    } catch (error) {
        console.error('執行雲端掃描時出錯:', error);
    }
}

run();
