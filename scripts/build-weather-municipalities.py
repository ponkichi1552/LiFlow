#!/usr/bin/env python3
"""Build the offline municipality index from the reviewed, hash-pinned public CSV.

No download occurs during app/server builds. A changed source requires explicit
review and an updated pin. The input contains public place data, not user data.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path

SOURCE_SHA256 = 'd8f14da1c1ff15f1118452eb0c334d3d8fc45f9df3ccf08fc176ba5856eb2689'
AMAMI = {'奄美市', '大和村', '宇検村', '瀬戸内町', '龍郷町', '喜界町', '徳之島町', '天城町', '伊仙町', '和泊町', '知名町', '与論町'}


def build(source):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError('Unreviewed municipality source: SHA-256 differs')
    groups = {}
    prefectures = {}
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    for row in rows:
        code, pref = row['市区町村コード'], row['都道府県コード']
        if len(code) != 5 or not code.isdecimal() or code[:2] != pref or not 1 <= int(pref) <= 47:
            raise ValueError('Invalid municipality code')
        prefecture = [row['都道府県名'], row['都道府県名カナ'], row['都道府県名ローマ字']]
        if prefectures.setdefault('JP-' + pref, prefecture) != prefecture:
            raise ValueError('Conflicting prefecture identity')
        label = (pref, row['都道府県名'], row['市区町村名'], row['市区町村名カナ'], row['市区町村名ローマ字'])
        group = groups.setdefault(code, {'label': label, 'points': []})
        if group['label'] != label:
            raise ValueError('Conflicting municipality identity')
        if not row['緯度'] or not row['経度']:
            continue  # The source has 441 missing town points; never invent them.
        lat, lon = float(row['緯度']), float(row['経度'])
        if not math.isfinite(lat) or not math.isfinite(lon) or not 20 <= lat <= 46 or not 122 <= lon <= 154:
            raise ValueError('Invalid Japanese representative coordinate')
        group['points'].append((lat, lon))
    # Designated cities are also searchable as a whole. Their stable IDs are
    # LiFlow-derived names, never falsely presented as official JIS city codes.
    aggregates = {}
    for group in list(groups.values()):
        pref, pref_name, name, kana, romaji = group['label']
        if '市' not in name or not name.endswith('区'):
            continue
        city = name[:name.index('市') + 1]
        key = (pref, city)
        aggregate = aggregates.setdefault(key, {'label': (pref, pref_name, city,
            '', romaji.split(' SHI')[0] + ' SHI'), 'points': []})
        aggregate['points'].extend(group['points'])
    result = []
    for code, group in sorted(groups.items()):
        result.append(encode('jp-municipal.' + code, group, 'municipality'))
    for (pref, city), group in sorted(aggregates.items()):
        # The kana before the final ward suffix is recovered from known city
        # names below; checked against all component labels during generation.
        candidates = [g['label'][3] for g in groups.values() if g['label'][0] == pref and g['label'][2].startswith(city)]
        common = candidates[0]
        for candidate in candidates[1:]:
            while not candidate.startswith(common):
                common = common[:-1]
        if not common.endswith('シ'):
            raise ValueError('Cannot derive designated-city kana unambiguously')
        group['label'] = (*group['label'][:3], common, group['label'][4])
        result.append(encode('jp-city.' + pref + '.' + hashlib.sha256(city.encode()).hexdigest()[:16], group, 'city'))
    if len(groups) != 1894 or len(rows) != 277630 or len({row[1] for row in result}) != 47:
        raise ValueError('Unexpected coverage: inspect the source before accepting it')
    amami = {row[3].split('郡')[-1] for row in result if row[8] == 'amami'}
    if amami != AMAMI:
        raise ValueError('Amami municipality mapping incomplete')
    return {'schemaVersion': 1, 'source': {'url': 'https://geolonia.github.io/japanese-addresses/latest.csv',
        'sha256': SOURCE_SHA256, 'reviewedOn': '2026-11-05', 'rows': len(rows), 'missingTownPoints': 441, 'license': 'CC BY 4.0',
        'attribution': 'Geolonia 住所データ（国土交通省位置参照情報等を基に作成）',
        'transformation': '市区町村単位に集約。町丁目代表点の平均に最も近い実在の代表点を選び、小数4桁に丸め。政令市の候補を派生。'},
        'columns': ['id', 'prefectureCode', 'prefecture', 'name', 'kana', 'romaji', 'latitude', 'longitude', 'islandGroup', 'kind', 'representativePointBounds'],
        'prefectures': prefectures, 'regions': result}


def encode(key, group, kind):
    pref, pref_name, name, kana, romaji = group['label']
    points = group['points']
    center = (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    representative = min(points, key=lambda p: ((p[0] - center[0]) ** 2 + ((p[1] - center[1]) * math.cos(math.radians(center[0]))) ** 2, p))
    bounds = [math.floor(min(p[0] for p in points) * 10000) / 10000, math.floor(min(p[1] for p in points) * 10000) / 10000,
        math.ceil(max(p[0] for p in points) * 10000) / 10000, math.ceil(max(p[1] for p in points) * 10000) / 10000]
    return [key, 'JP-' + pref, pref_name, name, kana, romaji, round(representative[0], 4), round(representative[1], 4),
        'amami' if pref == '46' and name.split('郡')[-1] in AMAMI else 'nonAmami' if pref == '46' else None, kind, bounds]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'server/appliance-care-api/src/weather/municipalities-data.json')
    args = parser.parse_args()
    value = build(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'regions': len(value['regions']), 'bytes': args.output.stat().st_size, 'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest()}))
