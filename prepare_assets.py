"""Package the existing cjf Gaussian output. No model installation or inference."""
from pathlib import Path
import gzip
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parents[1] / 'outputs' / 'ml-sharp_cjf'
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)
source = SOURCE / 'gaussians-preview.bin'
cfg = json.loads((SOURCE / 'preview-config.json').read_text(encoding='utf-8'))
assert source.stat().st_size == cfg['count'] * 52
target = ASSETS / 'scene.bin.gz'
with source.open('rb') as incoming, target.open('wb') as outgoing:
    with gzip.GzipFile(filename='', mode='wb', fileobj=outgoing, compresslevel=6, mtime=0) as compressed:
        shutil.copyfileobj(incoming, compressed)
cfg.update(focusDepth=cfg['nearDepth'], compressedBytes=target.stat().st_size,
           format='13 little-endian float32 values per Gaussian: xyz, rgb, opacity, xx, xy, xz, yy, yz, zz',
           source='cjf single-image ML-SHARP output',
           dataSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
           compressedSha256=hashlib.sha256(target.read_bytes()).hexdigest())
(ASSETS / 'scene.json').write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
shutil.copy2(SOURCE / 'rendered_preview.png', ASSETS / 'poster.png')
shutil.copy2(SOURCE / 'webgl_preview.mp4', ASSETS / 'preview.mp4')
licenses = ROOT / 'licenses'
licenses.mkdir(exist_ok=True)
for name in ['LICENSE', 'LICENSE_MODEL', 'ACKNOWLEDGEMENTS']:
    shutil.copy2(ROOT.parents[1] / 'outputs' / 'ml-sharp_DSC_1991' / name, licenses / ('ML-SHARP-' + name))
assert hashlib.sha256(gzip.decompress(target.read_bytes())).hexdigest() == cfg['dataSha256']
print(json.dumps({'count': cfg['count'], 'original_bytes': source.stat().st_size,
                  'compressed_bytes': target.stat().st_size, 'lossless_roundtrip': True}, ensure_ascii=False))
