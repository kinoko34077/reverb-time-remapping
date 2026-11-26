# プロトタイプ: Reverb Time Scrubber

`index.html` は、Muse 上で先行して作られた実験サイト「Reverb Time Scrubber」の現状スナップショットを、単一HTMLファイルとしてそのまま保存したものである。本リポジトリ（reverb-time-remapping）の正式実装ではなく、**プロトタイプ**として置く。

- 対応仕様: 本リポジトリ `docs/SPECIFICATION.md` の前身である初期実験仕様（5モード比較版）
- 開き方: `index.html` をブラウザで開くだけで動作する（外部ファイル・サーバー不要）

## 実装されているもの

- 5モード: Dry / Normal Reverb / Buffer Scrub（Wetキャッシュのグラニュラー読み取り）/ Spectral Scrub（STFT再合成）/ IR Scrub（IR時間窓の部分畳み込み）
- Source Time と Reverb Time の独立制御（波形上の直接操作、Freeze、逆行、速度変更、区間ループ／往復）
- 標準音源（バースト列、インパルス、サイン、矩形、鋸歯、ノイズ、持続和音、ピアノ単音・フレーズ、ドラム）と任意音声ファイル（MP3含む）・IRファイルの読み込み。秒数制限なし
- 実データ可視化: 原音／Wet／IR波形、Wetスペクトログラム、出力スペクトル、IR抽出窓
- A/B比較、Wet/Dry（線形 0〜100%）、自然減衰／音量補正の切替

## 既知の制約・未検証（2026-11-27 時点）

- 聴感検証は未実施の項目が多い。特に Wet/Dry 端点の漏れゼロはゲイン経路では確認済みだが、サンプル単位の出力実測は未実施（UNVERIFIED）
- ピッチ不変（Spectral）の数値実測、Freeze 持続音の継ぎ目、モード切替直後の過渡、サンプルレート混在時の挙動は未検証
- iOS Safari 実機での MP3 読み込みとタッチドラッグ操作は未検証
- 本プロトタイプは SPECIFICATION.md の8モード構成（Reverse Convolution、IR Spectral Remapping、Integrated Remapping 等）には未対応で、時間軸も Source／Reverb の2軸まで（IR Time／Wet Time／Output Time の分離は今後の正式実装で扱う）
