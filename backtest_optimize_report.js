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

// 5. 支撐壓力與共振信號分析 (全能完整版 - 與前端100%完全一致)

function calculateLastATR(data, period = 14) {
    if (!data || data.length < period) return 0;
    const atrSeries = calculateATRSeries(data, period);
    return atrSeries[atrSeries.length - 1] || 0;
}

function detectRSIDivergence(data) {
        if (!data || data.length < 20) return { bullDivergence: true, bearDivergence: true };
        const rsiArr = calculateRSI(data, 14);
        if (!rsiArr || rsiArr.length < 20) return { bullDivergence: true, bearDivergence: true };

        const sliceLen = Math.min(data.length, 30);
        const subData = data.slice(-sliceLen);
        const subRSI = rsiArr.slice(-sliceLen);

        const lastPrice = subData[subData.length - 1].close;
        const lastRSI = subRSI[subRSI.length - 1];
        const prevRSI = subRSI[subRSI.length - 2];

        // 1. 底背離 (Bullish Divergence): RSI 處於相對低位區 (< 50) 且 RSI 出現向上抬升回勾
        let bullDivergence = (lastRSI < 50) && (lastRSI > prevRSI);
        // 尋找過去 20 根內的價格與 RSI 走勢對比
        let minPrice = Infinity, minRsiVal = Infinity;
        for (let i = 0; i < subData.length - 2; i++) {
            if (subData[i].low < minPrice) {
                minPrice = subData[i].low;
                minRsiVal = subRSI[i];
            }
        }
        if (lastPrice <= minPrice * 1.01 && lastRSI > minRsiVal) {
            bullDivergence = true;
        }

        // 2. 頂背離 (Bearish Divergence): RSI 處於相對高位區 (> 50) 且 RSI 出現向下回落
        let bearDivergence = (lastRSI > 50) && (lastRSI < prevRSI);
        let maxPrice = -Infinity, maxRsiVal = -Infinity;
        for (let i = 0; i < subData.length - 2; i++) {
            if (subData[i].high > maxPrice) {
                maxPrice = subData[i].high;
                maxRsiVal = subRSI[i];
            }
        }
        if (lastPrice >= maxPrice * 0.99 && lastRSI < maxRsiVal) {
            bearDivergence = true;
        }

        return { bullDivergence, bearDivergence };
    }

function analyzeSNR(data, config = null, klines1h = null, fundingRate = null) {
        const activeConfig = config || config || { emaPeriod: 50, atrMultiplier: 1.5, riskRatio: 30 };
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

        // === ATR 2.0 動態帶狀止損防護罩 (Chandelier Exit) ===
        if (signal !== 'WATCH' && activeConfig.atr2Filter === 'ON' && data.length >= 5) {
            const past5Lows = data.slice(-5).map(k => k.low);
            const past5Highs = data.slice(-5).map(k => k.high);
            
            if (signal === 'LONG') {
                const lowestLow = Math.min(...past5Lows);
                sl = lowestLow - (lastATR * 1.8);
                if (sl >= lastPrice) sl = lastPrice * 0.985;
                rr = (tp - lastPrice) / (lastPrice - sl);
            } else if (signal === 'SHORT') {
                const highestHigh = Math.max(...past5Highs);
                sl = highestHigh + (lastATR * 1.8);
                if (sl <= lastPrice) sl = lastPrice * 1.015;
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

        // === 勝率過濾器 1: 5M 成交量爆量過濾器 (Volume Spike Filter) ===
        if (signal !== 'WATCH' && activeConfig.volumeFilter === 'ON') {
            const volMult = activeConfig.volumeMultiplier || 1.2;
            const past20Vols = data.slice(-21, -1).map(k => k.volume);
            if (past20Vols.length > 0) {
                const avgVol20 = past20Vols.reduce((a, b) => a + b, 0) / past20Vols.length;
                const lastVol = data[data.length - 1].volume;
                if (lastVol < avgVol20 * volMult) {
                    signal = 'WATCH';
                    rr = 0;
                    sl = 0;
                    tp = 0;
                }
            }
        }

        // === 勝率過濾器 2: 1H 多週期趨勢順勢過濾器 (Multi-Timeframe Filter) ===
        if (signal !== 'WATCH' && activeConfig.mtfFilter === 'ON' && klines1h && klines1h.length >= 50) {
            const closes1h = klines1h.map(k => parseFloat(k.close));
            const ema1h = calculateEMA(klines1h, 50);
            const last1hClose = closes1h[closes1h.length - 1];
            const last1hEMA = ema1h[ema1h.length - 1];
            const trend1h = last1hClose > last1hEMA ? 'LONG' : 'SHORT';
            
            if (signal !== trend1h) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        }

        // === 勝率過濾器 3: K 線反轉型態二次確認 (Pinbar / Bullish & Bearish Engulfing) ===
        if (signal !== 'WATCH' && activeConfig.pinbarFilter === 'ON' && data.length >= 2) {
            const lastCandle = data[data.length - 1];
            const prevCandle = data[data.length - 2];

            const o = lastCandle.open, h = lastCandle.high, l = lastCandle.low, c = lastCandle.close;
            const range = h - l;
            const body = Math.abs(c - o);
            const lowerShadow = Math.min(o, c) - l;
            const upperShadow = h - Math.max(o, c);

            let hasReversalPattern = false;

            if (signal === 'LONG') {
                // 1. 長下影線 Pinbar (鎚頭線)
                const isBullishPinbar = range > 0 && (lowerShadow >= range * 0.45) && (lowerShadow >= body * 1.5);
                // 2. 看漲吞噬 (Bullish Engulfing)
                const isBullishEngulfing = (prevCandle.close < prevCandle.open) && (c > o) && (c >= prevCandle.open) && (o <= prevCandle.close);
                
                if (isBullishPinbar || isBullishEngulfing) {
                    hasReversalPattern = true;
                }
            } else if (signal === 'SHORT') {
                // 1. 長上影線 Pinbar (倒鎚頭)
                const isBearishPinbar = range > 0 && (upperShadow >= range * 0.45) && (upperShadow >= body * 1.5);
                // 2. 看跌吞噬 (Bearish Engulfing)
                const isBearishEngulfing = (prevCandle.close > prevCandle.open) && (c < o) && (c <= prevCandle.open) && (o >= prevCandle.close);
                
                if (isBearishPinbar || isBearishEngulfing) {
                    hasReversalPattern = true;
                }
            }

            if (!hasReversalPattern) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        }

        // === 勝率過濾器 4: RSI 頂底背離二次確認 (RSI Divergence Filter) ===
        if (signal !== 'WATCH' && activeConfig.rsiDivFilter === 'ON') {
            const divRes = detectRSIDivergence(data);
            if (signal === 'LONG' && !divRes.bullDivergence) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            } else if (signal === 'SHORT' && !divRes.bearDivergence) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
        }

        // === 勝率過濾器 5: 幣安合約資金費率極端過濾器 (Funding Rate Filter) ===
        if (signal !== 'WATCH' && activeConfig.fundingFilter === 'ON' && fundingRate !== null) {
            // 資金費率 > +0.05% (+0.0005) 代表市場做多極度過熱，強烈禁止追多
            if (signal === 'LONG' && fundingRate > 0.0005) {
                signal = 'WATCH';
                rr = 0;
                sl = 0;
                tp = 0;
            }
            // 資金費率 < -0.05% (-0.0005) 代表市場做空極度恐慌，強烈禁止追空
            else if (signal === 'SHORT' && fundingRate < -0.0005) {
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
        const historicalWindow = klines.slice(0, i + 1);
        const analysis = analyzeSNR(historicalWindow, activeConfig);

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

    const defaultConfig = {
        emaPeriod: 50,
        atrMultiplier: 1.5,
        riskRatio: 30,
        feeRate: 0.05,
        slippage: 0.02,
        mtfFilter: 'ON',
        volumeFilter: 'ON',
        volumeMultiplier: 1.2,
        pinbarFilter: 'ON',
        rsiDivFilter: 'ON',
        fundingFilter: 'ON',
        atr2Filter: 'ON'
    };
    const strategyConfig = { ...defaultConfig, ...(userData.strategyConfig || {}) };
    
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
            .filter(t => t.symbol.endsWith('USDT') && !t.symbol.startsWith('RLUSD') && !t.symbol.startsWith('FDUSD') && t.symbol !== 'UUSDT' && t.symbol !== 'TRXUSDT')
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, 50)
            .map(t => t.symbol);
    } catch (err) {
        console.error('幣安下載熱門交易對失敗:', err);
        process.exit(1);
    }

    const interval = '15m';
    const limit = 3000;
    console.log(`已成功取得熱門交易對。準備為 50 大標的下載最近 ${limit} 根 ${interval.toUpperCase()} K 線...`);
    const allKlines = {};

    for (let i = 0; i < top50.length; i++) {
        const sym = top50[i];
        console.log(`[${i + 1}/${top50.length}] 正在下載 ${sym} 的歷史 15M K 線...`);
        try {
            const klines = await getBinanceKlines(sym, interval, limit);
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
                ...strategyConfig,
                emaPeriod: ema,
                atrMultiplier: atr
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
    msg += `• *回測配置*：${interval.toUpperCase()} 週期 / 最近 ${limit} 根 K 線\n`;
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
