const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname,'../dist/ui'), {recursive:true});
for (const file of ['index.html','app.js','styles.css']) fs.copyFileSync(path.join(__dirname,'../src/ui',file),path.join(__dirname,'../dist/ui',file));
fs.mkdirSync(path.join(__dirname,'../dist/ui/vendor'), {recursive:true});
if (fs.existsSync(path.join(__dirname,'../src/ui/vendor'))) for (const file of fs.readdirSync(path.join(__dirname,'../src/ui/vendor'))) fs.copyFileSync(path.join(__dirname,'../src/ui/vendor',file),path.join(__dirname,'../dist/ui/vendor',file));
fs.copyFileSync(path.join(__dirname,'../node_modules/mermaid/dist/mermaid.min.js'),path.join(__dirname,'../dist/ui/vendor/mermaid.min.js'));
