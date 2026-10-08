// 產生 index.json（FMP ADR 0030 §決定 1）。
//
//   dart run tool/build_index.dart          寫 index.json
//   dart run tool/build_index.dart --check  index.json 不是最新就以非零結束
//
// 讀每個含 `<目錄>/<目錄>.js` 的頂層目錄，解析標頭的 manifest，算 `.js` 與
// `checks.json` 的 SHA-256。順序依 id，格式固定，同樣的輸入永遠得到同樣的位元組。
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

const rawBase = 'https://raw.githubusercontent.com/1morr/fmp-plugins/main';

const _headerStart = '/* ==FMP Plugin==';
const _headerEnd = '==/FMP Plugin== */';
final _semver = RegExp(r'^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$');
final _id = RegExp(r'^[a-z][a-z0-9_-]*$');

/// 標頭或目錄不合規格：訊息要能直接告訴人哪個插件、哪裡錯。
class IndexBuildError implements Exception {
  IndexBuildError(this.message);

  final String message;

  @override
  String toString() => message;
}

/// 取出 `.js` 開頭的 manifest（JSON 物件）。[dir] 只用在錯誤訊息。
Map<String, Object?> parseHeader(String source, String dir) {
  final text = source.startsWith('﻿') ? source.substring(1) : source;
  if (!text.startsWith(_headerStart)) {
    throw IndexBuildError('$dir: file must start with "$_headerStart"');
  }
  final end = text.indexOf(_headerEnd);
  if (end < 0) throw IndexBuildError('$dir: missing "$_headerEnd"');
  final Object? json;
  try {
    json = jsonDecode(text.substring(_headerStart.length, end));
  } on FormatException catch (error) {
    throw IndexBuildError('$dir: header is not valid JSON (${error.message})');
  }
  if (json is! Map<String, Object?>) {
    throw IndexBuildError('$dir: header must be a JSON object');
  }
  return json;
}

String _string(Map<String, Object?> m, String key, String dir) {
  final value = m[key];
  if (value is! String || value.isEmpty) {
    throw IndexBuildError('$dir: header "$key" must be a non-empty string');
  }
  return value;
}

// manifest 的選填欄位：沒寫或 null 是空字串（上限由 FMP 的 manifest 解析檢查）。
String _description(Map<String, Object?> m, String dir) {
  final value = m['description'];
  if (value == null) return '';
  if (value is! String) {
    throw IndexBuildError('$dir: header "description" must be a string');
  }
  return value;
}

List<String> _strings(Map<String, Object?> m, String key, String dir) {
  final value = m[key];
  if (value is! List || value.any((e) => e is! String)) {
    throw IndexBuildError('$dir: header "$key" must be a list of strings');
  }
  return value.cast<String>();
}

String _sha256(File file) => sha256.convert(file.readAsBytesSync()).toString();

/// 掃 [root] 的頂層目錄，回傳 index.json 的完整內容（含結尾換行）。
String buildIndex(Directory root) {
  final dirs = root
      .listSync(followLinks: false)
      .whereType<Directory>()
      .map((d) => d.uri.pathSegments.where((s) => s.isNotEmpty).last)
      .where((name) => !name.startsWith('.'))
      .where((name) => File('${root.path}/$name/$name.js').existsSync())
      .toList();
  final entries = <Map<String, Object?>>[];
  for (final dir in dirs) {
    final js = File('${root.path}/$dir/$dir.js');
    final header = parseHeader(js.readAsStringSync(), dir);
    final id = _string(header, 'id', dir);
    if (!_id.hasMatch(id) || id != dir) {
      throw IndexBuildError(
        '$dir: header id "$id" must equal the directory name',
      );
    }
    final version = _string(header, 'version', dir);
    if (!_semver.hasMatch(version)) {
      throw IndexBuildError('$dir: header version "$version" is not a semver');
    }
    final apiVersion = header['apiVersion'];
    if (apiVersion is! int) {
      throw IndexBuildError('$dir: header "apiVersion" must be an integer');
    }
    final checks = File('${root.path}/$dir/checks.json');
    final hasChecks = checks.existsSync();
    entries.add({
      'id': id,
      'name': _string(header, 'name', dir),
      'author': _string(header, 'author', dir),
      'description': _description(header, dir),
      'version': version,
      'apiVersion': apiVersion,
      'capabilities': _strings(header, 'capabilities', dir),
      'allowedHosts': _strings(header, 'allowedHosts', dir),
      'url': '$rawBase/$dir/$dir.js',
      'sha256': _sha256(js),
      if (hasChecks) 'checksUrl': '$rawBase/$dir/checks.json',
      if (hasChecks) 'checksSha256': _sha256(checks),
    });
  }
  entries.sort((a, b) => (a['id']! as String).compareTo(b['id']! as String));
  const encoder = JsonEncoder.withIndent('  ');
  return '${encoder.convert({'indexVersion': 1, 'plugins': entries})}\n';
}

int run(
  List<String> args, {
  Directory? root,
  StringSink? out,
  StringSink? err,
}) {
  final stdoutSink = out ?? stdout;
  final stderrSink = err ?? stderr;
  final check = args.contains('--check');
  final unknown = args.where((a) => a != '--check');
  if (unknown.isNotEmpty) {
    stderrSink.writeln('usage: dart run tool/build_index.dart [--check]');
    return 64;
  }
  final dir = root ?? Directory.current;
  final String expected;
  try {
    expected = buildIndex(dir);
  } on IndexBuildError catch (error) {
    stderrSink.writeln('build_index: $error');
    return 1;
  }
  final file = File('${dir.path}/index.json');
  if (check) {
    final actual = file.existsSync() ? file.readAsStringSync() : null;
    if (actual != expected) {
      stderrSink.writeln(
        'index.json is stale or missing. Run `dart run tool/build_index.dart` '
        'and commit the result.',
      );
      return 1;
    }
    stdoutSink.writeln('index.json is up to date');
    return 0;
  }
  file.writeAsStringSync(expected);
  stdoutSink.writeln('wrote index.json');
  return 0;
}

void main(List<String> args) => exit(run(args));
