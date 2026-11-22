\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '5s';
CREATE EXTENSION IF NOT EXISTS xml2;
DO $test$
DECLARE
  doc xml := XMLPARSE(DOCUMENT '<root><item id="1">Привет</item><item id="2">world</item></root>');
  labels text;
BEGIN
  IF NOT xpath_exists('/root/item[@id="2"]', doc) THEN RAISE EXCEPTION 'XPath failed'; END IF;
  SELECT string_agg(label, ',' ORDER BY id) INTO labels
    FROM XMLTABLE('/root/item' PASSING doc COLUMNS id integer PATH '@id', label text PATH 'text()');
  IF labels <> 'Привет,world' THEN RAISE EXCEPTION 'XMLTABLE/Unicode failed'; END IF;
  IF xpath_string(doc::text, '/root/item[@id="1"]') <> 'Привет' THEN RAISE EXCEPTION 'xml2 extension failed'; END IF;
  IF position('<out>ok</out>' IN xslt_process('<root><value>ok</value></root>',
      '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><out><xsl:value-of select="root/value"/></out></xsl:template></xsl:stylesheet>')) = 0 THEN
    RAISE EXCEPTION 'libxslt compatibility failed';
  END IF;
  IF xpath('string(/r)', XMLPARSE(DOCUMENT '<!DOCTYPE r [<!ENTITY a "ok">]><r>&a;</r>'))::text[] <> ARRAY['ok'] THEN
    RAISE EXCEPTION 'Internal entity parsing failed';
  END IF;
  BEGIN
    PERFORM XMLPARSE(DOCUMENT '<root><broken></root>');
    RAISE EXCEPTION 'Malformed XML accepted';
  EXCEPTION WHEN invalid_xml_document THEN
    NULL;
  END;
  IF NOT xml_is_well_formed_document('<after-error>ok</after-error>') THEN RAISE EXCEPTION 'Parser did not recover'; END IF;
END
$test$;
SELECT 'XML XPath/XMLTABLE/XSLT/Unicode/entities/invalid input/extension PASS' AS result;
ROLLBACK;
