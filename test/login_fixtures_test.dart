import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

/// [root] 底下，`checks.json` 標了 `requiresLogin` 的案例裡沒有 `meta.edited` 的
/// fixture（相對路徑）。需要登入的回應帶著帳號資訊，遮蔽閘門只認得 id、名稱、頭像，
/// 所以這類 fixture 一律要經人工處理（手寫，或錄製後刪減），並在 `meta.edited` 寫明。
List<String> uneditedLoginFixtures(Directory root) {
  final found = <String>[];
  final plugins = root.listSync().whereType<Directory>().toList()
    ..sort((a, b) => a.path.compareTo(b.path));
  for (final plugin in plugins) {
    final checks = File('${plugin.path}/checks.json');
    if (!checks.existsSync()) continue;
    final cases = jsonDecode(checks.readAsStringSync()) as Map<String, Object?>;
    for (final MapEntry(key: name, value: spec) in cases.entries) {
      if (spec is! Map || spec['requiresLogin'] != true) continue;
      final dir = Directory('${plugin.path}/fixtures/$name');
      if (!dir.existsSync()) continue;
      final files = dir.listSync().whereType<File>().toList()
        ..sort((a, b) => a.path.compareTo(b.path));
      for (final file in files) {
        if (!file.path.endsWith('.json')) continue;
        final fixture = jsonDecode(file.readAsStringSync());
        final meta = fixture is Map ? fixture['meta'] : null;
        final edited = meta is Map ? meta['edited'] : null;
        if (edited is String && edited.trim().isNotEmpty) continue;
        found.add(
          '${plugin.uri.pathSegments.lastWhere((s) => s.isNotEmpty)}'
          '/fixtures/$name/${file.uri.pathSegments.last}',
        );
      }
    }
  }
  return found;
}

void main() {
  test('every fixture of a requiresLogin case is marked as edited', () {
    expect(uneditedLoginFixtures(Directory.current), isEmpty);
  });

  group('uneditedLoginFixtures', () {
    late Directory root;

    setUp(() => root = Directory.systemTemp.createTempSync('login_fixtures'));
    tearDown(() => root.deleteSync(recursive: true));

    void write(String path, Object json) {
      File('${root.path}/$path')
        ..createSync(recursive: true)
        ..writeAsStringSync(jsonEncode(json));
    }

    void checks(Map<String, Object?> cases) =>
        write('alpha/checks.json', cases);

    test('reports a recorded fixture of a requiresLogin case', () {
      checks({
        'login': {'requiresLogin': true},
      });
      write('alpha/fixtures/login/001.json', {
        'meta': {'recordedAt': '2026-10-15T00:00:00Z'},
      });
      expect(uneditedLoginFixtures(root), ['alpha/fixtures/login/001.json']);
    });

    test('accepts an edited one, ignores cases without requiresLogin', () {
      checks({
        'login': {'requiresLogin': true},
        'search': {'input': <String, Object?>{}},
      });
      write('alpha/fixtures/login/001.json', {
        'meta': {'edited': 'hand-written'},
      });
      write('alpha/fixtures/search/001.json', {
        'meta': {'recordedAt': '2026-10-15T00:00:00Z'},
      });
      expect(uneditedLoginFixtures(root), isEmpty);
    });

    test('an empty note does not count, and formatting does not matter', () {
      checks({
        'login': {'requiresLogin': true},
      });
      File('${root.path}/alpha/fixtures/login/001.json')
        ..createSync(recursive: true)
        ..writeAsStringSync(
          const JsonEncoder.withIndent('    ').convert({
            'request': <String, Object?>{},
            'meta': {'edited': '  '},
          }),
        );
      expect(uneditedLoginFixtures(root), ['alpha/fixtures/login/001.json']);
    });
  });
}
