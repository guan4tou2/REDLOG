import * as yaml from 'js-yaml'

/** One YAML document, read the way config.yaml and profile files were read
 *  under js-yaml 4. Its JSON_SCHEMA was the YAML 1.2 core schema (`~`, an
 *  empty value and `Null` are null; `True` is true; `0x1F` is 31); js-yaml 5
 *  made JSON_SCHEMA strict and turns those into strings, so a hand-edited
 *  file would change meaning. js-yaml 5 also throws on an empty or
 *  comment-only file, which 4 read as null. */
export function loadYamlDocument(raw: string): unknown {
  const docs = yaml.loadAll(raw, { schema: yaml.CORE_SCHEMA })
  if (docs.length > 1) throw new yaml.YAMLException('expected a single document in the stream, but found more')
  return docs[0] ?? null
}
