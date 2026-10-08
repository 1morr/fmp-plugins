import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:test/test.dart';

import '../tool/build_index.dart';

String header(Map<String, Object?> overrides) {
  final manifest = {
    'id': 'alpha',
    'name': 'Alpha',
    'version': '1.2.3',
    'author': 'FMP',
    'apiVersion': 1,
    'capabilities': ['search'],
    'allowedHosts': ['example.com'],
    ...overrides,
  };
  return '/* ==FMP Plugin==\n${jsonEncode(manifest)}\n'
      '==/FMP Plugin== */\nexport async function search() {}\n';
}

void main() {
  late Directory root;

  setUp(() => root = Directory.systemTemp.createTempSync('build_index_test'));
  tearDown(() => root.deleteSync(recursive: true));

  void plugin(String dir, String source, {String? checks}) {
    Directory('${root.path}/$dir').createSync();
    File('${root.path}/$dir/$dir.js').writeAsStringSync(source);
    if (checks != null) {
      File('${root.path}/$dir/checks.json').writeAsStringSync(checks);
    }
  }

  Map<String, Object?> readIndex() =>
      jsonDecode(File('${root.path}/index.json').readAsStringSync())
          as Map<String, Object?>;

  int build(List<String> args, {StringSink? err}) => run(
        args,
        root: root,
        out: StringBuffer(),
        err: err ?? StringBuffer(),
      );

  test('writes exactly the index fields with real SHA-256 values', () {
    final source = header({});
    plugin('alpha', source, checks: '{"checks":[]}');
    expect(build([]), 0);
    final index = readIndex();
    expect(index.keys, ['indexVersion', 'plugins']);
    expect(index['indexVersion'], 1);
    final entry = (index['plugins']! as List).single as Map<String, Object?>;
    expect(entry.keys, [
      'id',
      'name',
      'author',
      'description',
      'version',
      'apiVersion',
      'capabilities',
      'allowedHosts',
      'url',
      'sha256',
      'checksUrl',
      'checksSha256',
    ]);
    expect(entry['id'], 'alpha');
    expect(entry['version'], '1.2.3');
    expect(entry['capabilities'], ['search']);
    expect(entry['allowedHosts'], ['example.com']);
    expect(
      entry['url'],
      'https://raw.githubusercontent.com/1morr/fmp-plugins/main/alpha/alpha.js',
    );
    expect(
      entry['checksUrl'],
      'https://raw.githubusercontent.com/1morr/fmp-plugins/main/alpha/checks.json',
    );
    expect(entry['sha256'], sha256.convert(utf8.encode(source)).toString());
    expect(
      entry['checksSha256'],
      sha256.convert(utf8.encode('{"checks":[]}')).toString(),
    );
  });

  test('orders by id, skips directories without a matching js, is stable', () {
    plugin('zeta', header({'id': 'zeta'}));
    plugin('alpha', header({}));
    Directory('${root.path}/not_a_plugin').createSync();
    File('${root.path}/not_a_plugin/other.js').writeAsStringSync('x');
    build([]);
    final first = File('${root.path}/index.json').readAsStringSync();
    expect([
      for (final p in readIndex()['plugins']! as List) (p as Map)['id'],
    ], [
      'alpha',
      'zeta'
    ]);
    build([]);
    expect(File('${root.path}/index.json').readAsStringSync(), first);
    expect(first.endsWith('}\n'), isTrue);
  });

  test('--check passes when current and fails when stale or missing', () {
    plugin('alpha', header({}));
    final err = StringBuffer();
    expect(build(['--check'], err: err), 1);
    expect(err.toString(), contains('stale or missing'));
    build([]);
    expect(build(['--check']), 0);
    plugin('alpha', '${header({})}// edited\n');
    err.clear();
    expect(build(['--check'], err: err), 1);
    expect(err.toString(), contains('stale'));
  });

  test('--check also fails on a reformatted index', () {
    plugin('alpha', header({}));
    build([]);
    final file = File('${root.path}/index.json');
    file.writeAsStringSync(jsonEncode(jsonDecode(file.readAsStringSync())));
    expect(build(['--check']), 1);
  });

  group('a bad header fails loudly', () {
    void expectFails(String source, String message) {
      plugin('alpha', source);
      final err = StringBuffer();
      expect(build([], err: err), 1);
      expect(err.toString(), contains(message));
      expect(File('${root.path}/index.json').existsSync(), isFalse);
    }

    test('no header', () => expectFails('export const x = 1;', 'must start'));
    test(
      'unterminated',
      () => expectFails('/* ==FMP Plugin==\n{}', 'missing'),
    );
    test(
      'invalid json',
      () => expectFails(
        '/* ==FMP Plugin==\n{oops\n==/FMP Plugin== */',
        'not valid JSON',
      ),
    );
    test(
      'id differs from directory',
      () => expectFails(header({'id': 'beta'}), 'must equal the directory'),
    );
    test(
        'bad version', () => expectFails(header({'version': '1.0'}), 'semver'));
    test(
      'missing field',
      () => expectFails(header({'allowedHosts': null}), '"allowedHosts"'),
    );
  });
}
