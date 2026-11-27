# R2b 有限比較プレイヤー
正規版の独立入口 app/。先行 prototype/ は比較基準として保持。R2bの限定実装は生成音源（ピアノ・ドラム風は合成）、生成IR、ローカルWAV、正負Predelay、Dry/Normal/Reverse、Dry/Wetソロ、共通時間座標での再生・一時停止・seek・方式比較。
- FWのWAV readerと数値binding、ATFのPCM bridge/Workletの固定供給を利用。Workletが静的importするdual/rustモジュールも依存として供給するが、正規入口はraw処理のみ利用。WASM処理・別モデルを有効化しない。
- 素材・比較信号・再生の責務を分離。native OfflineAudioContextの有限畳み込みを利用し、比較用3信号を共通座標に整列。先読み負配置を含むため負の共通時刻が表示される。比較全体で同一の安全ゲインを用いる。
- 初期素材は48kHz、WAVは部分読取し上限内で有限PCM化、異レートはnative resample。8MiB読込推定枠、64MiB比較PCM推定枠は初期安全制限で、総実メモリの保証ではない。圧縮音源・長尺の逐次再生は未対応。
- 再生は選択信号のATF bridgeを接続し、方式変更では停止コマンドの受領座標を使用して共通時刻を維持。Wetの有限比較キャッシュは「Wet設定を反映」または方式切替で更新する。無音間隔ゼロの保証はしない。Workletのrender-applied/progressを観測。要求・準備中・失敗を区別し、不正素材は既存比較を維持。
- R2bでは有限比較の操作を先行し、IR/Wet独立操作、残響再合成、自然/補正切替の全機能、実データ可視化はR3以降。ブラウザ試験は物理端末や聴感を代替しない。

## R3a 部分IR比較
IR Windowは指定したage区間を無正規化で切り出し、区間先頭をage=0へ移して既存入力と畳み込む。Predelayは共通。終端超過は残存範囲で切り、実適用範囲を表示。範囲外の開始はエラーにしlast-good比較を維持。比較全体の時間座標と安全ゲインに含める。現段階は明示再準備の有限比較で、連続スクラブ、クロスフェード・Wet時間操作・既発生残響の巻戻しは未受入。

## R3b1 Wet独立再生
Wet Bufferは通常Wetの有限キャッシュをATF raw Workletで直接走査、Wet Spectralは同一キャッシュをATF peak-locked PV Workletで再合成。Source/Dryは別Workletで独立参照する。速度0のrawは参照アンカー周辺50msの局所ループ、PVは速度0で位相継続。50msは初期比較値でありユーザー固定値ではない。反復は比較区間全体。時刻表示は共通符号付き座標。Source変更はキャッシュ済みWetの再畳み込みではない。PVピーク変動は共通安全gain後のpreview-only ceilingで制限し、線形基準DSPとは分離。独立起動のサンプル同期、任意A/B範囲・pingpong、連続IR窓更新、聴感・実機は後続受入。

## R3b2a IR窓の有限更新と試聴切替
準備済み素材に対し、指定窓だけを再畳み込みし、Dry/Normal/Reverseのキャッシュを保持する。連続要求は一計算ずつ最新優先。旧結果は新しい要求を上書きせず、失敗時はlast-goodを維持。IR Window再生中は新Workletの実render receiptを確認してから25msの出力crossfadeを行う。別Workletの開始は最新render clockから推定するためsample-exact同期・無瞬断の完全保証ではない。有限事前入力の再計算であり、現在入力へのリアルタイム時変畳み込みではない。自然減衰は無補正、RMS補正は全IR/選択窓のRMS比を全ch共通に適用（初期上限8倍、無音窓は無音）。安全ゲインは比較全体に適用し線形値とは分離。25ms/8倍は検証用暫定値。任意区間/往復・他モードの補正・IR Spectral・聴感/実機は残る。

## R3b2b1 任意反復区間
Source/Wetの反復区間を共通符号付き時間座標（秒、内部frame、終了排他）で独立指定。既存ATF atomic setLoopConfigurationを使用。範囲外または逆転した区間は適用せず、最後に受理された区間を表示する。反復OFFは区間を設定として保持し再生範囲を制限しない。raw固定の50ms局所carrierは反復区間そのものではない。往復readerは別の共有機構の受入後に導入。
