#!/usr/bin/env python3
"""Rebuild the Sheets spike corpus from its pinned sources, without trusting the copies.

Reads manifest.json next to this script, downloads every workbook from its
pinned raw URL (a fixed commit, so the bytes cannot change) and checks each
download against the sha256 in the manifest. A file is written to the target
folder only if its hash matches. Nothing downloaded is opened or run.

Standard library only. Uses HTTPS_PROXY and the system CA store (or
SSL_CERT_FILE) if they are set.

  python3 -I fetch.py TARGET_DIR              # download all workbooks
  python3 -I fetch.py TARGET_DIR --only O01 P02
  python3 -I fetch.py TARGET_DIR --licences   # also re-download LICENSES/
  python3 -I fetch.py --check                 # verify files/ and LICENSES/ here, no network

Exit status is 0 only if every requested file matched.
"""
import argparse, hashlib, json, os, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_BYTES = 64 * 1024 * 1024  # largest workbook is about 5 MB
RAW = 'https://raw.githubusercontent.com/{repo}/{commit}/{path}'


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def download(url, dest_dir, attempts=3):
    """Download url to a temp file in dest_dir; return (temp path, sha256)."""
    last = None
    for i in range(attempts):
        fd, tmp = tempfile.mkstemp(dir=dest_dir, prefix='.part-')
        try:
            h, n = hashlib.sha256(), 0
            req = urllib.request.Request(url, headers={'User-Agent': 'hearth-corpus-fetch/1'})
            with urllib.request.urlopen(req, timeout=120) as r, os.fdopen(fd, 'wb') as out:
                while True:
                    block = r.read(1 << 20)
                    if not block:
                        break
                    n += len(block)
                    if n > MAX_BYTES:
                        raise ValueError(f'more than {MAX_BYTES} bytes')
                    h.update(block)
                    out.write(block)
            return tmp, h.hexdigest()
        except Exception as e:  # retry network errors, then give up
            last = e
            if os.path.exists(tmp):
                os.remove(tmp)
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'{url}: {last}')


def fetch_one(url, want_sha, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp, got = download(url, os.path.dirname(dest))
    if got != want_sha:
        os.remove(tmp)
        return f'MISMATCH sha256 {got} (expected {want_sha})'
    os.replace(tmp, dest)
    os.chmod(dest, 0o644)
    return 'ok'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('target', nargs='?', help='folder to download into (created if missing)')
    ap.add_argument('--only', nargs='+', metavar='ID', help='corpus ids to fetch, e.g. O01 P02')
    ap.add_argument('--licences', action='store_true', help='also re-download the licence texts')
    ap.add_argument('--check', action='store_true', help='verify the local copies only; no network')
    a = ap.parse_args()
    with open(os.path.join(HERE, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)
    files = m['files']
    if a.only:
        want = {i.upper() for i in a.only}
        files = [f for f in files if f['id'] in want]
        missing = want - {f['id'] for f in files}
        if missing:
            sys.exit(f'unknown ids: {", ".join(sorted(missing))}')
    bad = 0
    if a.check:
        for f in files:
            p = os.path.join(HERE, f['file'])
            st = 'missing' if not os.path.exists(p) else ('ok' if sha256_file(p) == f['sha256'] else 'MISMATCH')
            bad += st != 'ok'
            print(f"{f['id']:4} {st:8} {f['file']}")
        for e in m['licence_texts']:
            p = os.path.join(HERE, e['file'])
            st = 'missing' if not os.path.exists(p) else ('ok' if sha256_file(p) == e['sha256'] else 'MISMATCH')
            bad += st != 'ok'
            print(f"lic  {st:8} {e['file']}")
        print(f'{bad} problem(s)')
        sys.exit(1 if bad else 0)
    if not a.target:
        ap.error('TARGET_DIR is required unless --check is given')
    target = os.path.abspath(a.target)
    os.makedirs(target, exist_ok=True)
    for f in files:
        dest = os.path.join(target, f['file'])
        try:
            st = fetch_one(f['source']['raw_url'], f['sha256'], dest)
        except Exception as e:
            st = f'FAILED {e}'
        bad += st != 'ok'
        print(f"{f['id']:4} {st}  {f['file']}  <- {f['source']['raw_url']}", flush=True)
    if a.licences:
        for e in m['licence_texts']:
            url = RAW.format(repo=e['repo'], commit=e['commit'], path=e['path'])
            try:
                st = fetch_one(url, e['sha256'], os.path.join(target, e['file']))
            except Exception as ex:
                st = f'FAILED {ex}'
            bad += st != 'ok'
            print(f"lic  {st}  {e['file']}  <- {url}", flush=True)
    print(f'{bad} problem(s); files in {target}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
