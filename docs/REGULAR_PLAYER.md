# R2b 有限比較プレイヤー
正規版の独立入口 app/。先行 prototype/ は比較基準として保持。R2bの限定実装は生成音源（ピアノ・ドラム風は合成）、生成IR、ローカルWAV、正負Predelay、Dry/Normal/Reverse、Dry/Wetソロ、共通時間座標での再生・一時停止・seek・方式比較。
- FWのWAV readerと数値binding、ATFのPCM bridge/Workletの固定供給を利用。Workletが静的importするdual/rustモジュールも依存として供給するが、正規入口はraw処理のみ利用。WASM処理・別モデルを有効化しない。
- 素材・比較信号・再生の責務を分離。native OfflineAudioContextの有限畳み込みを利用し、比較用3信号を共通座標に整列。先読み負配置を含むため負の共通時刻が表示される。比較全体で同一の安全ゲインを用いる。
- 初期素材は48kHz、WAVは部分読取し上限内で有限PCM化、異レートはnative resample。8MiB読込推定枠、64MiB比較PCM推定枠は初期安全制限で、総実メモリの保証ではない。圧縮音源・長尺の逐次再生は未対応。
- 再生は選択信号のATF bridgeを接続し、方式変更では共通時刻を維持して切替。無音間隔ゼロの保証はしない。Workletのrender-applied/progressを観測。要求・準備中・失敗を区別し、不正素材は既存比較を維持。
- R2bでは有限比較の操作を先行し、IR/Wet独立操作、残響再合成、自然/補正切替の全機能、実データ可視化はR3以降。ブラウザ試験は物理端末や聴感を代替しない。
