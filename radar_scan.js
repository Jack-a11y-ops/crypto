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

// 核心 SNR 分析邏輯
function analyzeSNR(data, lastPrice) {
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

    const threshold = lastPrice * 0.006;
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

    if (support && resistance) {
        const distToSupport = (lastPrice - support.value) / lastPrice;
        const distToResistance = (resistance.value - lastPrice) / lastPrice;

        if (distToSupport < 0.015) {
            signal = 'LONG';
            rr = (resistance.value - lastPrice) / (lastPrice - support.value * 0.985);
        } else if (distToResistance < 0.015) {
            signal = 'SHORT';
            rr = (lastPrice - support.value) / (resistance.value * 1.015 - lastPrice);
        }
    }

    return { levels, support, resistance, signal, rr };
}

// 主執行流程
async function run() {
    console.log(`[${new Date().toLocaleString()}] 啟動 SNR 雷達雲端掃描，目標使用者: ${userEmail}...`);

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
        const tickersResponse = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        const tickers = await tickersResponse.json();
        const top50 = tickers
            .filter(t => t.symbol.endsWith('USDT'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, 50);

        const opportunities = [];

        // 4. 批量分析每個交易對
        for (const item of top50) {
            try {
                const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${item.symbol}&interval=${interval}&limit=150`;
                const klinesResponse = await fetch(klinesUrl);
                const klines = await klinesResponse.json();
                
                if (klines.length < 100) continue;

                const chartData = klines.map(d => ({
                    close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3])
                }));

                const lastPrice = chartData[chartData.length - 1].close;
                const analysis = analyzeSNR(chartData, lastPrice);

                if (analysis.signal !== 'WATCH' && analysis.rr > 1.0) {
                    opportunities.push({
                        symbol: item.symbol,
                        signal: analysis.signal,
                        rr: analysis.rr,
                        lastPrice: lastPrice,
                        support: analysis.support,
                        resistance: analysis.resistance
                    });
                }
            } catch (e) {
                // 靜默跳過異常幣種
            }
        }

        console.log(`掃描完畢。共找到 ${opportunities.length} 個符合高盈虧比 (R:R > 1.0) 的交易信號。`);

        // 5. 去重篩選
        const now = Date.now();
        const newOpportunities = [];

        opportunities.forEach(opp => {
            const key = `${opp.symbol}_${interval}_${opp.signal}`;
            const lastNotified = notified[key];
            
            // 10 分鐘去重限制 (10 * 60 * 1000 毫秒)
            if (!lastNotified || (now - lastNotified) > 10 * 60 * 1000) {
                newOpportunities.push(opp);
                notified[key] = now;
            }
        });

        // 6. 如果有新機會，發送 Email 並同步更新歷史紀錄與已通知時間戳
        if (newOpportunities.length > 0) {
            console.log(`發現 ${newOpportunities.length} 個新機會！準備發送 Email 通知...`);

            // 6.1 格式化郵件內文
            let messageText = `親愛的 SNR TRACER 使用者，您好：\n\n系統已在雲端背景掃描中，偵測到符合條件的優質交易機會！\n\n`;
            messageText += `雷達週期：${interval.toUpperCase()}\n\n`;
            messageText += `【新交易機會清單】:\n`;
            
            newOpportunities.forEach((opp, i) => {
                const cleanSym = opp.symbol.replace('USDT', '');
                const dir = opp.signal === 'LONG' ? '買入 (LONG) 📈' : '賣出 (SHORT) 📉';
                messageText += `${i + 1}. ${cleanSym}/USDT | 建議信號: ${dir} | 盈虧比: ${opp.rr.toFixed(2)}\n`;
                
                // 6.2 同步寫入歷史紀錄 (比照前端 saveToHistory)
                const tp = opp.signal === 'LONG' ? opp.resistance.value : opp.support.value;
                const sl = opp.signal === 'LONG' ? opp.support.value * 0.985 : opp.resistance.value * 1.015;

                // 歷史紀錄 3 分鐘內防重複寫入
                const isDuplicate = history.some(item => 
                    item.symbol === opp.symbol && 
                    item.interval === interval && 
                    item.type === opp.signal && 
                    (now - item.id) < 3 * 60 * 1000
                );

                if (!isDuplicate) {
                    const date = new Date(now);
                    const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
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
                        status: 'PENDING'
                    });
                }
            });

            messageText += `\n請儘速前往您的 SNR TRACER 平台查看詳情與設定防守點位！\n`;
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
