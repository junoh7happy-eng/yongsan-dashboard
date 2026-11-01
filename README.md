# 용산구 부동산 대시보드 (한아름부동산)

국토교통부 실거래가·한국부동산원 R-ONE 주간 가격지수 기반 용산구 아파트 브리핑 대시보드.

## 실행
1. Node.js 18 이상 설치
2. `config.example.json` 을 `config.json` 으로 복사하고 인증키 입력
   - 공공데이터포털(data.go.kr) 인증키: 아파트 매매·전월세 실거래가 API 활용신청
   - 한국부동산원 R-ONE(reb.or.kr/r-one) 인증키
3. `start.bat` 실행 (또는 `node server.js` 후 http://localhost:8080 접속)

`config.json` 은 API 키가 들어 있으므로 저장소에 올리지 마세요.
