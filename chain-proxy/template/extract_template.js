const fs = require('fs');
const path = require('path');

const EXAMPLES_DIR = path.resolve(__dirname, 'examples');
const OUTPUT_DIR = path.resolve(__dirname);

function isTopLevelKey(line) {
    const withoutBom = line.replace(/^\uFEFF/, "");
    return /^[a-zA-Z0-9_-]+:/.test(withoutBom);
}

function extractFlowName(line) {
    const m = line.match(/name:\s*([^,}]+)/);
    return m ? m[1].trim() : null;
}

function extractTemplate(inputFile, outputFile) {
    const content = fs.readFileSync(inputFile, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    const out = [];
    let inProxies = false;
    let inProxyGroups = false;
    let currentGroupHasProxies = false;
    let groupIndex = 0;
    let firstGroupOutIndex = -1;   // 第一个代理组在 out 数组中的索引
    const groupNames = [];          // 所有代理组的名称

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isTopLevelKey(line)) {
            if (line.startsWith('proxies:')) {
                inProxies = true;
                inProxyGroups = false;
                out.push(line);
                continue;
            } else if (line.startsWith('proxy-groups:')) {
                inProxies = false;
                inProxyGroups = true;
                groupIndex = 0;
                out.push(line);
                continue;
            } else {
                inProxies = false;
                inProxyGroups = false;
            }
        }

        if (inProxies) {
            if (/^\s*-/.test(line) || /^\s+/.test(line) || line.trim() === '') {
                continue;
            }
        }

        if (inProxyGroups) {
            // flow-style: - { name: ..., proxies: [...] }
            if (/^\s+-\s*\{.*name:/.test(line)) {
                const name = extractFlowName(line);
                if (name) groupNames.push(name);

                // 清空 proxies，先用占位符，后续再替换第一个组
                const cleaned = line.replace(/proxies:\s*\[.*?\]/g, "proxies: []");
                if (groupIndex === 0) {
                    firstGroupOutIndex = out.length;
                }
                out.push(cleaned);
                groupIndex++;
                continue;
            }
            // block-style start: - name: ...
            if (/^\s+-\s*name:/.test(line) && !/^\s+-\s*\{/.test(line)) {
                const n = line.replace(/^\s+-\s*name:\s*/, '').replace(/^['"]|['"]$/g, '').trim();
                if (n) groupNames.push(n);

                if (groupIndex === 0) {
                    firstGroupOutIndex = out.length;
                }
                groupIndex++;
                currentGroupHasProxies = false;
                out.push(line);
                continue;
            }
            // block-style proxies key
            if (/^\s+proxies:/.test(line)) {
                out.push(line.split(':')[0] + ': []');
                currentGroupHasProxies = true;
                continue;
            }
            // Skip proxies list items
            if (currentGroupHasProxies && /^\s+-\s+/.test(line)) {
                continue;
            }
            // Keep other fields like type, url, interval
            if (/^\s+/.test(line) && line.trim() !== '') {
                currentGroupHasProxies = false;
                out.push(line);
                continue;
            }
            continue;
        }

        out.push(line);
    }

    // ── 后处理：将其他组名注入到第一个组的 proxies 中 ──
    if (firstGroupOutIndex >= 0 && groupNames.length > 1) {
        const otherNames = groupNames.slice(1);
        const firstLine = out[firstGroupOutIndex];
        // flow-style: proxies: [] → proxies: [自动选择, 故障转移]
        if (firstLine.includes('proxies: []')) {
            out[firstGroupOutIndex] = firstLine.replace('proxies: []', `proxies: [${otherNames.join(', ')}]`);
        }
    }

    fs.writeFileSync(outputFile, out.join('\n'), 'utf8');
    console.log(`Generated template: ${outputFile}`);
    console.log(`  Groups: ${groupNames.join(', ')}`);
}

function processAll() {
    if (!fs.existsSync(EXAMPLES_DIR)) {
        console.error(`Dir not found: ${EXAMPLES_DIR}`);
        return;
    }

    const files = fs.readdirSync(EXAMPLES_DIR);
    let count = 0;

    for (const file of files) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
            continue;
        }

        if (file.includes('output') || file.includes('chain')) {
            continue;
        }

        const inputFile = path.join(EXAMPLES_DIR, file);
        const outputFile = path.join(OUTPUT_DIR, file);

        console.log(`Processing: ${file}`);
        extractTemplate(inputFile, outputFile);
        count++;
    }

    console.log(`\nSuccessfully processed ${count} files.`);
}

processAll();
