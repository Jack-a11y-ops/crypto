/**
 * SNR TRACER - Backtest Parameter Optimizer & Telegram Report
 * 每日定時歷史回測評估 (15M 週期 / 3000根 K 線 / 前 50 大成交量幣種)
 * 並將最優 Top 3 參數組合推播至 Telegram
 */

if (typeof fetch === 'undefined') {
    console.error('錯誤：本腳本需要 Node.js v18 或更高版本（支援原生 fetch）。');
    process.exit(1);
}

// 1. 指數移動平均線 (EMA) 計算
function calculateEMA(data, period = 50) {
    const k = 2 / (period + 1);
    const emaArr = [];
    if (data.length === 0) return emaArr;
    let ema = data[0].close;
    emaArr.push(ema);
    for (let i = 1; i < data.length; i++) {
        ema = (data[i].close * k) + (ema * (1 - k));
        emaArr.push(ema);
    }
    return emaArr;
}

// 2. 平均真實波幅 (ATR) 系列計算 (返回每根 K 線的 ATR 陣列)
function calculateATRSeries(data, period = 14) {
    const atrArr = new Array(data.length).fill(0);
    if (data.length < period) return atrArr;
    
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
    atrArr[period - 1] = atr;

    for (let i = period; i < data.length; i++) {
        atr = (atr * (period - 1) + trArr[i]) / period;
        atrArr[i] = atr;
    }
    return atrArr;
}

// 3. Wilder's Smoothing RSI 計算
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

// 4. MACD 計算
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

// 5. 支撐壓力與共振信號分析 (預計算極速版)
function analyzeSNRFast(klines, idx, precalculated, config) {
    const emaPeriod = config.emaPeriod || 50;
    const atrMultiplier = config.atrMultiplier || 1.5;

    const lastPrice = klines[idx].close;
    
    // 直接獲取預計算指標
    const lastEMA = precalculated.ema[emaPeriod][idx];
    const prevEMA = precalculated.ema[emaPeriod][idx - 1];
    const lastATR = precalculated.atr[idx];
    const lastRSI = precalculated.rsi[idx];
    const lastHist = precalculated.macdHist[idx];
    const prevHist = precalculated.macdHist[idx - 1];

    // 篩選出 index <= idx - 2 的 pivots
    const pivots = precalculated.pivots.filter(p => p.index <= idx - 2);

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

    const triggerDist = lastATR > 0 ? lastATR * atrMultiplier : lastPrice * (atrMultiplier * 0.01);
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

    if (signal === 'LONG') {
        if (lastPrice < lastEMA && lastEMA < prevEMA) {
            signal = 'WATCH';
            rr = 0;
            sl = 0;
            tp = 0;
        }
    } else if (signal === 'SHORT') {
        if (lastPrice > lastEMA && lastEMA > prevEMA) {
            signal = 'WATCH';
            rr = 0;
            sl = 0;
            tp = 0;
        }
    }

    if (signal === 'LONG' && lastRSI !== null && lastRSI > 65) {
        signal = 'WATCH';
        rr = 0;
        sl = 0;
        tp = 0;
    } else if (signal === 'SHORT' && lastRSI !== null && lastRSI < 35) {
        signal = 'WATCH';
        rr = 0;
        sl = 0;
        tp = 0;
    }

    let winRate = 0.50;
    if (signal !== 'WATCH') {
        const level = signal === 'LONG' ? support : resistance;
        if (level && level.count) {
            winRate += Math.min((level.count - 2) * 0.02, 0.08);
        }

        const isEMAUprising = lastEMA > prevEMA;
        const isEMADeclining = lastEMA < prevEMA;
        
        if (signal === 'LONG') {
            if (lastPrice > lastEMA && isEMAUprising) winRate += 0.08;
            else if (lastPrice < lastEMA && isEMAUprising) winRate += 0.02;
        } else if (signal === 'SHORT') {
            if (lastPrice < lastEMA && isEMADeclining) winRate += 0.08;
            else if (lastPrice > lastEMA && isEMADeclining) winRate += 0.02;
        }

        const levelVal = signal === 'LONG' ? support.value : resistance.value;
        const distToLevel = Math.abs(lastPrice - levelVal);
        if (lastATR > 0) {
            winRate += Math.min(Math.max((atrMultiplier - (distToLevel / lastATR)) * 0.04, -0.02), 0.06);
        }

        if (signal === 'LONG' && lastRSI !== null && lastRSI < 40) winRate += 0.08;
        else if (signal === 'SHORT' && lastRSI !== null && lastRSI > 60) winRate += 0.08;

        if (lastHist !== null && prevHist !== null) {
            if (signal === 'LONG') {
                if (lastHist > 0 || lastHist > prevHist) winRate += 0.05;
                else if (lastHist < 0 && lastHist < prevHist) winRate -= 0.05;
            } else if (signal === 'SHORT') {
                if (lastHist < 0 || lastHist < prevHist) winRate += 0.05;
                else if (lastHist > 0 && lastHist > prevHist) winRate -= 0.05;
            }
        }
    } else {
        winRate = 0.0;
    }
    
    winRate = Math.min(Math.max(winRate, 0.35), 0.75);

    return { levels, support, resistance, signal, rr, sl, tp, lastATR, winRate, rsi: lastRSI, macdHist: lastHist };
}

// 6. 無副作用策略回測計算 (極速版)
function evaluateStrategyFast(klines, symbol, precalculated, config = null) {
    const activeConfig = config || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
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
        const analysis = analyzeSNRFast(klines, i, precalculated, activeConfig);

        if (activeTrade) {
            // 勝率平倉替換 (CLOSED)
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

            // 觸發 TP / SL
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
            // 開倉訊號
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

// 7. 前向分頁拉取 K 線 (3000根以上) - 使用 data-api.binance.vision 避開 IP 封鎖
async function getBinanceKlines(symbol, interval, requiredLimit = 3000) {
    let allKlines = [];
    let endTime = null;
    
    while (allKlines.length < requiredLimit) {
        const fetchLimit = Math.min(1000, requiredLimit - allKlines.length);
        let url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${fetchLimit}`;
        if (endTime) {
            url += `&endTime=${endTime}`;
        }
        
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`下載 ${symbol} 行情失敗, 狀態碼: ${response.status}`);
                break;
            }
            const data = await response.json();
            if (!Array.isArray(data) || data.length === 0) {
                break;
            }
            
            allKlines = data.concat(allKlines);
            endTime = data[0][0] - 1;
            
            if (data.length < fetchLimit) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (err) {
            console.error(`拉取 ${symbol} K 線出錯:`, err);
            break;
        }
    }
    
    return allKlines.map(d => ({
        openTime: Number(d[0]),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

// 8. 發送 Telegram 訊息
async function sendTelegramMessage(token, chatId, text) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown'
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Telegram 回應錯誤: ${response.status} - ${errText}`);
        }
    } catch (err) {
        console.error('發送 Telegram 警報訊息出錯:', err);
    }
}

// 9. 主程式執行
async function run() {
    const userEmail = process.env.USER_EMAIL;
    if (!userEmail) {
        console.error('錯誤：找不到環境變數 USER_EMAIL。請在 GitHub Secrets 中配置您的登入電子信箱。');
        process.exit(1);
    }
    
    const safeEmail = userEmail.replace(/\./g, '_');
    const rtdbUrl = `https://crypto-6536b-default-rtdb.firebaseio.com/users/${safeEmail}.json`;

    console.log(`正在獲取 Firebase 配置...`);
    let userData = null;
    try {
        const dbResponse = await fetch(rtdbUrl);
        if (!dbResponse.ok) {
            throw new Error(`無法連接 Firebase 雲端資料庫, status: ${dbResponse.status}`);
        }
        userData = await dbResponse.json();
    } catch (err) {
        console.error('從 Firebase 載入使用者資料失敗:', err);
        process.exit(1);
    }

    if (!userData) {
        console.error('錯誤：找不到該使用者的雲端資料。請先在網頁端登入並創建帳戶。');
        process.exit(1);
    }

    const telegramConfig = userData.telegramConfig || {};
    const { telegramToken, telegramChatId } = telegramConfig;
    if (!telegramToken || !telegramChatId) {
        console.error('警告：Telegram 通知設定不完整。請先於網頁端「全市場雷達掃描」分頁中填寫並儲存設定。');
        process.exit(0);
    }

    const strategyConfig = userData.strategyConfig || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30, feeRate: 0.05, slippage: 0.02 };
    
    console.log(`Firebase 設定讀取成功。Telegram 頻道就緒。`);
    console.log(`正在從幣安下載前 50 大成交量標的...`);

    let top50 = [];
    try {
        const tickersResponse = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr');
        if (!tickersResponse.ok) {
            throw new Error(`獲取行情失敗, status: ${tickersResponse.status}`);
        }
        const tickers = await tickersResponse.json();
        top50 = tickers
            .filter(t => t.symbol.endsWith('USDT') && !t.symbol.startsWith('RLUSD') && !t.symbol.startsWith('FDUSD'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, 50)
            .map(t => t.symbol);
    } catch (err) {
        console.error('幣安下載熱門交易對失敗:', err);
        process.exit(1);
    }

    console.log(`已成功取得熱門交易對。準備為 50 大標的下載最近 3000 根 15M K 線...`);
    const allKlines = {};

    for (let i = 0; i < top50.length; i++) {
        const sym = top50[i];
        console.log(`[${i + 1}/${top50.length}] 正在下載 ${sym} 的歷史 15M K 線...`);
        try {
            const klines = await getBinanceKlines(sym, '15m', 3000);
            if (klines && klines.length >= 100) {
                allKlines[sym] = klines;
            } else {
                console.warn(`警告：${sym} 取得數據量不足 (${klines ? klines.length : 0}根)，跳過。`);
            }
        } catch (err) {
            console.error(`下載 ${sym} K線失敗:`, err);
        }
        await new Promise(resolve => setTimeout(resolve, 30));
    }

    console.log('K 線下載完畢。開始進行指標預計算以優化網格搜尋效能...');
    const precalculatedData = {};
    for (const sym in allKlines) {
        const klines = allKlines[sym];
        
        // 預計算各週期 EMA
        const emaData = {};
        for (const period of [20, 50, 100, 200]) {
            emaData[period] = calculateEMA(klines, period);
        }
        
        // 預計算 ATR
        const atrData = calculateATRSeries(klines, 14);
        
        // 預計算 RSI
        const rsiData = calculateRSI(klines, 14);
        
        // 預計算 MACD
        const macdData = calculateMACD(klines);
        
        // 預計算 Pivots
        const pivots = [];
        for (let i = 2; i < klines.length - 2; i++) {
            if (klines[i].high > klines[i - 1].high && klines[i].high > klines[i - 2].high &&
                klines[i].high > klines[i + 1].high && klines[i].high > klines[i + 2].high) {
                pivots.push({ type: 'high', value: klines[i].high, index: i });
            }
            if (klines[i].low < klines[i - 1].low && klines[i].low < klines[i - 2].low &&
                klines[i].low < klines[i + 1].low && klines[i].low < klines[i + 2].low) {
                pivots.push({ type: 'low', value: klines[i].low, index: i });
            }
        }
        
        precalculatedData[sym] = {
            ema: emaData,
            atr: atrData,
            rsi: rsiData,
            macdHist: macdData.hist,
            pivots: pivots
        };
    }

    console.log('指標預計算完畢。開始極速網格搜尋交叉回測最佳化...');

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
                riskRatio: strategyConfig.riskRatio || 30,
                feeRate: strategyConfig.feeRate !== undefined ? strategyConfig.feeRate : 0.05,
                slippage: strategyConfig.slippage !== undefined ? strategyConfig.slippage : 0.02
            };

            combinationIndex++;
            console.log(`評估網格組合 [${combinationIndex}/${totalCombinations}]: ${ema} EMA + ${atr.toFixed(1)}x ATR...`);

            let totalTradesCombined = 0;
            let winTradesCombined = 0;
            let totalPnLCombined = 0;

            for (const sym in allKlines) {
                const klines = allKlines[sym];
                const precalc = precalculatedData[sym];
                const trades = evaluateStrategyFast(klines, sym, precalc, testConfig);

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

            const winRate = totalTradesCombined > 0 ? (winTradesCombined / totalTradesCombined * 100) : 0.0;
            results.push({
                ema: ema,
                atr: atr,
                totalTrades: totalTradesCombined,
                winRate: winRate,
                totalPnL: totalPnLCombined
            });
        }
    }

    // 按累計組合收益降序排列，篩選 Top 3
    results.sort((a, b) => b.totalPnL - a.totalPnL);

    console.log('最佳化計算與排序完成。準備發送 Telegram 績效報告...');

    const now = new Date();
    // 轉換台灣時間時間戳記 (GMT+8)
    const localTimeStr = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' (GMT+8)';

    let msg = `📊 *Crypto SNR 每日回測最佳化報告*\n\n`;
    msg += `• *評估對象*：成交量前 50 大 USDT 交易對\n`;
    msg += `• *回測配置*：15M 週期 / 最近 3000 根 K 線\n`;
    msg += `• *運行時間*：${localTimeStr}\n\n`;
    msg += `🏆 *最佳策略參數組合 Top 3 推薦*:\n\n`;

    const medals = ['🥇 第一名', '🥈 第二名', '🥉 第三名'];
    for (let i = 0; i < Math.min(3, results.length); i++) {
        const r = results[i];
        const pnlSign = r.totalPnL >= 0 ? '+' : '';
        msg += `${medals[i]}：*${r.ema} EMA / ${r.atr.toFixed(1)}x ATR*\n`;
        msg += `   • 累計收益：\`${pnlSign}${r.totalPnL.toFixed(2)} R\`\n`;
        msg += `   • 綜合勝率：\`${r.winRate.toFixed(1)}%\`\n`;
        msg += `   • 總交易數：\`${r.totalTrades} 筆\`\n\n`;
    }

    msg += `*提示*：您可以至平台網頁端，點選歷史回測的二維熱力圖，或於自定義策略面板中手動套用上述最優參數，Actions 雲端自動雷達監控將會無縫同步！\n`;
    msg += `平台連結：https://spontaneous-kheer-c470e5.netlify.app/`;

    console.log('\n--- Telegram 報告內容 ---');
    console.log(msg);
    console.log('------------------------\n');
    await sendTelegramMessage(telegramToken, telegramChatId, msg);
    console.log('報告發送成功。每日最佳化任務執行完成！');
}

run();
