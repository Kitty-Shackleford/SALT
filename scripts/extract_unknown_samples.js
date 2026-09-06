#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const LOG_PATH = 'logs/run-scan-parse3.out';
const DOWNLOADS_DIR = process.argv[2] || process.env.DOWNLOADS_DIR || 'downloads';
const MAX_TS = 40;
const MAX_SAMPLES = 20;

function unique(arr){ return [...new Set(arr)]; }

function findAdmFiles(dir){
  const out = [];
  function walk(d){
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for(const e of entries){
      const p = path.join(d, e.name);
      if(e.isDirectory()) walk(p);
      else if(e.isFile() && p.endsWith('.ADM')) out.push(p);
    }
  }
  try{ walk(dir); } catch(e){/* ignore */}
  return out;
}

function readFileLines(file){
  try{
    return fs.readFileSync(file,'utf8').split(/\r?\n/);
  } catch(e){ return []; }
}

function main(){
  if(!fs.existsSync(LOG_PATH)){
    console.error('Log file not found:', LOG_PATH);
    process.exit(1);
  }
  const log = fs.readFileSync(LOG_PATH,'utf8');
  const m = [...log.matchAll(/Missing structureType for event at (\S+Z)/g)].map(x=>x[1]);
  const timestamps = unique(m).slice(0, MAX_TS);
  console.log('Found timestamps count:', timestamps.length);

  const admFiles = findAdmFiles(DOWNLOADS_DIR);
  if(admFiles.length===0){
    console.error('No ADM files found under', DOWNLOADS_DIR);
    process.exit(1);
  }

  const actionRegex = /(\bplaced\b|\bBuilt\b|\bDismantled\b|\bfolded\b|has raised|Mounted|Unmounted|placed)/i;
  let samples = [];

  for(const ts of timestamps){
    if(samples.length>=MAX_SAMPLES) break;
    const timeMatch = ts.match(/T(\d{2}:\d{2}:\d{2})Z/);
    if(!timeMatch) continue;
    const timepart = timeMatch[1];

    // search for action keyword at that second first
    let found = null;
    for(const file of admFiles){
      const lines = readFileLines(file);
      for(let i=0;i<lines.length;i++){
        const line = lines[i];
        if(line.indexOf(`${timepart} |`)===-1) continue;
        if(actionRegex.test(line)){
          found = { file, lineno: i+1, line, reason: 'action_match', ts };
          break;
        }
      }
      if(found) break;
    }

    if(!found){
      // fallback: any line at that second
      for(const file of admFiles){
        const lines = readFileLines(file);
        for(let i=0;i<lines.length;i++){
          const line = lines[i];
          if(line.indexOf(`${timepart} |`)!==-1){
            found = { file, lineno: i+1, line, reason: 'time_fallback', ts };
            break;
          }
        }
        if(found) break;
      }
    }

    if(found) samples.push(found);
    else samples.push({ file: null, lineno: null, line: null, reason: 'no_match', ts });
  }

  // print samples
  for(let i=0;i<samples.length;i++){
    const s = samples[i];
    console.log('\n--- Sample ' + (i+1) + ' ---');
    console.log('timestamp:', s.ts);
    console.log('match_type:', s.reason);
    if(s.file){
      console.log('file:', s.file + ':' + s.lineno);
      console.log('line:', s.line);
    } else {
      console.log('No matching ADM/RPT line found for this timestamp');
    }
  }
  console.log('\nTotal samples:', samples.length);
}

main();
